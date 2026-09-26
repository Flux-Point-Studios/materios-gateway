#!/usr/bin/env bash
# Runs gateway-autoroll.sh against stubbed docker, curl, date and sleep, covering every
# decision the cron job makes, including telling someone when it cannot run at all.
#   (see the guard below for where it may run)
set -uo pipefail

# The script under test recreates the live gateway. Where a docker socket is reachable, a
# script that ignored the stubs would do exactly that, so run only where none is:
#   docker run --rm -v "$PWD:/w" -w /w node:20-bookworm bash deploy/autoroll/test.sh
if [ -S /var/run/docker.sock ] || command -v docker >/dev/null 2>&1; then
  echo "refusing to run with docker reachable; use a container without the docker socket" >&2
  exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=ghcr.io/flux-point-studios/materios-gateway
OLD=sha256:$(printf 'a%.0s' $(seq 64))
NEW=sha256:$(printf 'b%.0s' $(seq 64))
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails + 1)); }

# A scenario: the gateway runs $OLD and :latest resolves to $OLD, healthy, at t=1000000.
# State lives in files under $T that the stubs read and write.
scenario() {
  T=$(mktemp -d)
  mkdir -p "$T/bin" "$T/compose/gateway-autoroll"
  touch "$T/compose/docker-compose.yml"
  echo 1000000 > "$T/now"; echo 200 > "$T/health"; : > "$T/bad"
  echo "$OLD" > "$T/running"; echo "$OLD" > "$T/latest"
  echo 0 > "$T/pull.rc"; : > "$T/pull.err"; : > "$T/alerts"; : > "$T/recreated"
  echo "https://discord.example/api/webhooks/1/test" > "$T/compose/gateway-autoroll/webhook"
  cat > "$T/bin/docker" <<EOF
#!/usr/bin/env bash
T=$T
case "\$1" in
  pull) [ "\$(cat \$T/pull.rc)" = 0 ] || { cat \$T/pull.err >&2; exit 1; } ;;
  image)
    case "\$3" in
      *:latest) d=\$(cat \$T/latest) ;;
      running-image) d=\$(cat \$T/running) ;;
      *@*) d=\${3#*@} ;;
      *) exit 1 ;;
    esac
    echo "$IMAGE@\$d" ;;
  ps) echo running-container ;;
  inspect) case "\$*" in *Config.Image*) echo "$IMAGE@\$(cat \$T/running)" ;; *) echo running-image ;; esac ;;
  compose) echo "\$GATEWAY_IMAGE" >> \$T/recreated; echo "\${GATEWAY_IMAGE#*@}" > \$T/running ;;
esac
EOF
  cat > "$T/bin/curl" <<EOF
#!/usr/bin/env bash
T=$T
case "\$*" in
  *discord*) printf '%s\n' "\$*" >> \$T/alerts ;;
  *) if [ "\$(cat \$T/running)" = "\$(cat \$T/bad)" ]; then printf 500; else printf '%s' "\$(cat \$T/health)"; fi ;;
esac
EOF
  cat > "$T/bin/date" <<EOF
#!/usr/bin/env bash
[ "\$*" = +%s ] && exec cat $T/now
exec /usr/bin/date "\$@"
EOF
  printf '#!/usr/bin/env bash\n' > "$T/bin/sleep"
  chmod +x "$T/bin/"*
}
run() {
  PATH="$T/bin:$PATH" AUTOROLL_COMPOSE_DIR="$T/compose" AUTOROLL_HEALTH_TIMEOUT=3 AUTOROLL_POLL=1 \
    bash "$HERE/gateway-autoroll.sh" >> "$T/log" 2>&1
}
advance() { echo $(( $(cat "$T/now") + $1 )) > "$T/now"; }
alerts() { wc -l < "$T/alerts" | tr -d ' '; }
good() { cat "$T/compose/gateway-autoroll/good.digest" 2>/dev/null; }
pinned() { cat "$T/compose/.env" 2>/dev/null; }

scenario; run
if grep -q "up-to-date" "$T/log" && [ "$(alerts)" = 0 ] && [ ! -s "$T/recreated" ] && [ "$(good)" = "$OLD" ]; then
  ok "an up-to-date gateway is left alone and recorded as good"
else bad "up-to-date run: $(tail -1 "$T/log")"; fi

scenario; echo "$NEW" > "$T/latest"; run
if [ "$(cat "$T/running")" = "$NEW" ] && [ "$(good)" = "$NEW" ] && [ "$(pinned)" = "GATEWAY_IMAGE=$IMAGE@$NEW" ] \
  && grep -q "rolled" "$T/alerts"; then
  ok "a healthy new :latest is deployed by digest, pinned in .env and announced"
else bad "healthy roll: $(tail -2 "$T/log" | tr '\n' ' ')"; fi

scenario; echo "$NEW" > "$T/latest"; echo "$NEW" > "$T/bad"; echo "$OLD" > "$T/compose/gateway-autoroll/good.digest"; run
if [ "$(cat "$T/running")" = "$OLD" ] && [ "$(good)" = "$OLD" ] && grep -q "^$NEW 1$" "$T/compose/gateway-autoroll/failed.digest" \
  && grep -q "FAILED health-gate" "$T/alerts"; then
  ok "an unhealthy new :latest is rolled back to the running digest and counted"
else bad "unhealthy roll: $(tail -2 "$T/log" | tr '\n' ' ')"; fi

scenario; echo 500 > "$T/health"; echo "$NEW" > "$T/compose/gateway-autoroll/good.digest"; echo "$OLD" > "$T/running"
printf '#!/usr/bin/env bash\necho 200 > %s/health\n' "$T" > "$T/bin/heal"; chmod +x "$T/bin/heal"
sed -i "s|^  compose) |  compose) $T/bin/heal; |" "$T/bin/docker"; run
if [ "$(cat "$T/running")" = "$NEW" ] && grep -q "auto-recovered" "$T/alerts"; then
  ok "a DOWN gateway is recreated on the recorded good digest"
else bad "down recovery: $(tail -2 "$T/log" | tr '\n' ' ')"; fi

# The regression that went unnoticed for seven weeks: every pull failed and nobody heard.
scenario; echo 1 > "$T/pull.rc"; echo 'unexpected status from HEAD request: 403 Forbidden' > "$T/pull.err"; run
if grep -q "403 Forbidden" "$T/log" && [ "$(alerts)" = 0 ]; then
  ok "a failed pull logs the registry's own error and does not alert yet"
else bad "first failed pull: log=[$(tail -1 "$T/log")] alerts=$(alerts)"; fi
advance 1800; run
if [ "$(alerts)" = 0 ]; then ok "half an hour of failed pulls still does not alert"; else bad "alerted after 30 minutes"; fi
advance 1800; run
if [ "$(alerts)" = 1 ] && grep -q "403 Forbidden" "$T/alerts" && grep -q "not run for 1h" "$T/alerts"; then
  ok "an hour of failed pulls alerts once, naming the error"
else bad "one-hour escalation: alerts=$(alerts) [$(tail -1 "$T/alerts")]"; fi
advance 3600; run
if [ "$(alerts)" = 1 ]; then ok "the alert is not repeated within a day"; else bad "re-alerted within a day: $(alerts)"; fi
advance 86400; run
if [ "$(alerts)" = 2 ] && grep -q "not run for 26h" "$T/alerts"; then
  ok "a failure still going a day later alerts again"
else bad "daily re-alert: alerts=$(alerts) [$(tail -1 "$T/alerts")]"; fi
echo 0 > "$T/pull.rc"; advance 300; run
if [ "$(alerts)" = 3 ] && tail -1 "$T/alerts" | grep -q "running again" && [ ! -e "$T/compose/gateway-autoroll/skip.since" ]; then
  ok "the first good run after an alert says so and clears the failure clock"
else bad "recovery notice: alerts=$(alerts) [$(tail -1 "$T/alerts")]"; fi
advance 300; echo 1 > "$T/pull.rc"; run; advance 3000; run
if [ "$(alerts)" = 3 ]; then ok "a new failure starts a fresh hour before alerting"; else bad "stale failure clock: alerts=$(alerts)"; fi

scenario; sed -i 's|^  inspect) .*|  inspect) echo "" ;;|; s|^      running-image) .*|      running-image) exit 1 ;;|' "$T/bin/docker"
run; advance 3600; run
if grep -q "cannot resolve the running digest" "$T/log" && [ "$(alerts)" = 1 ] && grep -q "running digest" "$T/alerts"; then
  ok "an unresolvable running image escalates the same way"
else bad "running-digest escalation: alerts=$(alerts) [$(tail -1 "$T/log")]"; fi

[ "$fails" -eq 0 ] || { echo "$fails test(s) failed"; exit 1; }
echo "all autoroll tests passed"
