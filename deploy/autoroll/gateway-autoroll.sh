#!/usr/bin/env bash
# gateway-autoroll.sh — health-gated auto-rollout + self-heal for blob-gateway-preprod.
#
# On a new ghcr.io/.../materios-gateway:latest digest (Woodpecker publishes it on every
# main merge, #437): recreate the service pinned to that DIGEST, wait for /health, and
# ROLL BACK to the last-good digest if it doesn't come up healthy. The good digest is
# persisted to .env (GATEWAY_IMAGE=), so a bare `docker compose up` / host reboot /
# nginx-proxy (which depends_on this svc) recreate onto the GOOD digest, never a bad
# :latest. If the gateway is ever DOWN (bad roll, hung process, failed rollback), the
# next run force-recreates it on the good digest and re-alerts — DOWN is recoverable,
# never terminal. If it cannot even compare digests (pull or inspect failing) for an hour,
# it alerts with the error, then daily, and says so when it runs again. Cron: */5 * * * *.
# Disarm by commenting the cron line. Installed on Gemtek as
# /home/deci/materios-node/gateway-autoroll.sh; tests: deploy/autoroll/test.sh.
set -uo pipefail
export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin"   # cron's PATH is minimal; docker/curl/python3 live here

COMPOSE_DIR=${AUTOROLL_COMPOSE_DIR:-/home/deci/materios-node}
COMPOSE=$COMPOSE_DIR/docker-compose.yml
ENV_FILE=$COMPOSE_DIR/.env                 # compose reads ${GATEWAY_IMAGE} from here → durable pin to the good digest
SVC=blob-gateway-preprod
IMAGE=ghcr.io/flux-point-studios/materios-gateway
HEALTH_URL=http://localhost:3002/health
DEEP_URL=http://localhost:3002/chain-info  # deeper functional probe (non-fatal warn only)
STATE=$COMPOSE_DIR/gateway-autoroll
GOOD_F=$STATE/good.digest
FAILED_F=$STATE/failed.digest              # "<digest> <attempts>" — blacklist after MAX_HEALTH_RETRIES
DOWN_F=$STATE/down.since                    # epoch of last DOWN recovery attempt (throttles re-attempt+re-alert)
WEBHOOK_F=$STATE/webhook
HEALTH_TIMEOUT=${AUTOROLL_HEALTH_TIMEOUT:-180}  # generous: genesis-wipe shim + node boot; avoids false-failing a slow-but-good image
POLL=${AUTOROLL_POLL:-3}
MAX_HEALTH_RETRIES=2                         # a new digest gets this many gate attempts (across runs) before permanent blacklist
DOWN_REALERT=1800                           # while DOWN: re-attempt recovery + re-alert at most this often (30 min)
SKIP_F=$STATE/skip.since                    # epoch the current run of skipped checks began
SKIP_ALERTED_F=$STATE/skip.alerted          # epoch of the last "auto-update is not running" alert
SKIP_ALERT_AFTER=3600                       # one skip is a registry blip; an hour of them means auto-update is off
SKIP_REALERT=86400

mkdir -p "$STATE"
exec 9>"$STATE/.lock"; flock -n 9 || { echo "$(date -Is) another run in progress; skip"; exit 0; }

now(){ date +%s; }
log(){ echo "$(date -Is) $*"; }
alert(){
  local wh=""; [ -s "$WEBHOOK_F" ] && wh=$(cat "$WEBHOOK_F")
  [ -z "$wh" ] && wh=$(grep -hoE 'https://discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+' "$COMPOSE_DIR"/watchdog-finality.sh 2>/dev/null | head -1)
  [ -n "$wh" ] && curl -s -m 10 -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"content":"🛰️ gateway-autoroll: "+sys.argv[1]}))' "$1")" "$wh" >/dev/null 2>&1
}
health_ok(){ [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$HEALTH_URL" 2>/dev/null)" = 200 ]; }
deep_ok(){   [ "$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$DEEP_URL" 2>/dev/null)" = 200 ]; }
# require 2 consecutive 200s so a one-shot fluke / mid-recreate blip doesn't read as healthy
wait_health(){ local t=0 ok=0; while [ "$t" -lt "$HEALTH_TIMEOUT" ]; do
  if health_ok; then ok=$((ok+1)); [ "$ok" -ge 2 ] && return 0; else ok=0; fi; sleep "$POLL"; t=$((t+POLL)); done; return 1; }
digest_of(){ timeout 30 docker image inspect "$1" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null | sed 's/.*@//'; }
running_digest(){ local cid img d
  cid=$(timeout 15 docker ps -q -f "name=$SVC" 2>/dev/null); [ -z "$cid" ] && return 1
  img=$(timeout 15 docker inspect "$cid" --format '{{.Image}}' 2>/dev/null); [ -z "$img" ] && return 1
  d=$(digest_of "$img")
  # RepoDigests can go empty on the running image after a newer :latest pull
  # re-homes the repo refs; the digest-pinned Config.Image still has the truth.
  [ -z "$d" ] && d=$(timeout 15 docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null | grep -o 'sha256:[0-9a-f]\{64\}')
  [ -n "$d" ] && printf '%s\n' "$d"; }
pin_env(){ printf 'GATEWAY_IMAGE=%s@%s\n' "$IMAGE" "$1" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"; }  # full pullable ref, not a bare digest
recreate(){ GATEWAY_IMAGE="$1" timeout 300 docker compose -f "$COMPOSE" up -d "$SVC" >/dev/null 2>&1; }
recreate_force(){ GATEWAY_IMAGE="$1" timeout 300 docker compose -f "$COMPOSE" up -d --force-recreate "$SVC" >/dev/null 2>&1; }
short(){ echo "sha256:${1:7:12}"; }
# skip REASON: this run cannot compare digests. Alert once the skips have lasted an hour,
# then daily: pull failures were logged for seven weeks here without anyone hearing.
skip(){ local nowt since last
  nowt=$(now); log "$1 — skip"
  [ -s "$SKIP_F" ] || echo "$nowt" > "$SKIP_F"
  since=$(cat "$SKIP_F"); last=$(cat "$SKIP_ALERTED_F" 2>/dev/null || echo 0)
  if [ $((nowt - since)) -ge "$SKIP_ALERT_AFTER" ] && [ $((nowt - last)) -ge "$SKIP_REALERT" ]; then
    echo "$nowt" > "$SKIP_ALERTED_F"
    alert "⚠️ auto-update has not run for $(( (nowt - since) / 3600 ))h: $1"
  fi
  exit 0; }
# The digests resolved: end any run of skips, announcing it if it had been alerted.
resolved(){
  [ -s "$SKIP_ALERTED_F" ] && alert "auto-update running again after $(( ($(now) - $(cat "$SKIP_F")) / 3600 ))h of skipped checks"
  rm -f "$SKIP_F" "$SKIP_ALERTED_F"; }

# ── 0) DOWN handler: gateway unhealthy → force-recreate the last-good digest (recoverable, throttled) ──
if ! health_ok; then
  GOOD=$(cat "$GOOD_F" 2>/dev/null); last=$(cat "$DOWN_F" 2>/dev/null || echo 0); nowt=$(now)
  if [ "$last" != 0 ] && [ $((nowt - last)) -lt "$DOWN_REALERT" ]; then
    log "gateway DOWN, throttled ($((nowt - last))s since last action); skipping"; exit 0
  fi
  if [ -z "$GOOD" ]; then
    echo "$nowt" > "$DOWN_F"; log "gateway DOWN and NO known-good digest recorded"
    alert "🚨 CRITICAL: $SVC DOWN and no known-good digest to recover to — manual intervention required."; exit 0
  fi
  log "gateway /health DOWN — force-recreating last-good $(short "$GOOD")"
  pin_env "$GOOD"; recreate_force "$IMAGE@$GOOD"
  if wait_health; then
    rm -f "$DOWN_F"; log "recovered to $(short "$GOOD")"; alert "gateway was DOWN — auto-recovered to $(short "$GOOD") (healthy)"
  else
    echo "$nowt" > "$DOWN_F"; log "recovery FAILED — gateway still DOWN"
    alert "🚨 CRITICAL: $SVC DOWN and recovery to good $(short "$GOOD") FAILED — manual intervention required."
  fi
  exit 0
fi
rm -f "$DOWN_F"   # healthy now

# ── 1) resolve remote :latest vs running digest ──
err=$(timeout 120 docker pull -q "$IMAGE:latest" 2>&1 >/dev/null) \
  || skip "pull :latest failed: $(printf '%s' "${err:-no output (timed out?)}" | tail -n 1 | cut -c1-200)"
R=$(digest_of "$IMAGE:latest"); C=$(running_digest)
[ -n "$R" ] || skip "cannot resolve the :latest digest"
[ -n "$C" ] || skip "cannot resolve the running digest"
resolved
if [ ! -s "$GOOD_F" ]; then echo "$C" > "$GOOD_F"; fi   # first-ever baseline = whatever runs now
[ -s "$ENV_FILE" ] || pin_env "$C"                       # ensure the durable pin exists

# ── 2) already on latest? ──
if [ "$R" = "$C" ]; then log "up-to-date ($(short "$C"))"; echo "$C" > "$GOOD_F"; pin_env "$C"; exit 0; fi

# ── 3) flap guard: skip a digest already blacklisted (failed MAX_HEALTH_RETRIES times) ──
fdig=""; fcnt=0; [ -s "$FAILED_F" ] && read -r fdig fcnt < "$FAILED_F"
if [ "$R" = "$fdig" ] && [ "${fcnt:-0}" -ge "$MAX_HEALTH_RETRIES" ]; then
  log "remote :latest $(short "$R") is blacklisted (failed ${fcnt}× ) — skipping"; exit 0
fi

# ── 4) new digest → deploy + health-gate (2 consecutive /health 200 within ${HEALTH_TIMEOUT}s) ──
GOOD="$C"   # rollback target = the digest running-and-healthy THIS run (not the file)
log "new :latest $(short "$R") (running $(short "$C")) — deploying"
if recreate "$IMAGE@$R" && wait_health; then
  echo "$R" > "$GOOD_F"; pin_env "$R"; : > "$FAILED_F"
  deep_ok && dw="" || dw=" (WARN: /chain-info != 200 — verify chain wiring)"
  log "deploy OK, healthy on $(short "$R")$dw"
  alert "rolled $SVC → $(short "$R") (healthy)$dw; previous $(short "$GOOD")"
  exit 0
fi

# ── 5) unhealthy → roll back to last-good, record the failed attempt (blacklist after MAX) ──
if [ "$R" = "$fdig" ]; then fcnt=$((fcnt+1)); else fcnt=1; fi
printf '%s %s\n' "$R" "$fcnt" > "$FAILED_F"
log "$(short "$R") failed health-gate (attempt ${fcnt}/${MAX_HEALTH_RETRIES}) — rolling back to $(short "$GOOD")"
if recreate "$IMAGE@$GOOD" && wait_health; then
  pin_env "$GOOD"
  log "rollback to $(short "$GOOD") OK (healthy)"
  alert "⚠️ :latest $(short "$R") FAILED health-gate (attempt ${fcnt}/${MAX_HEALTH_RETRIES}) — rolled BACK to $(short "$GOOD"). Investigate the CI image."
else
  echo "$(now)" > "$DOWN_F"
  log "ROLLBACK ALSO UNHEALTHY — gateway DOWN"
  alert "🚨 CRITICAL: roll to $(short "$R") failed AND rollback to $(short "$GOOD") failed — $SVC DOWN, manual intervention required."
fi
exit 0
