/**
 * Pure milestone state machine for the SPO journey page. No I/O — the route
 * gathers chain/db-sync/heartbeat inputs and this module turns them into the
 * five-milestone verdict an external SPO operator reads top-to-bottom:
 *
 *   registered → selected → authoring → liveness → finality
 *
 * The journey exists because external Cardano SPOs routinely get lost between
 * "I submitted my registration tx" and "I'm producing blocks", and one
 * failure mode (bootstrapping from genesis replay instead of the current
 * snapshot) leaves their GRANDPA voter in a divergent room: they author but
 * never finalize.
 */

// Must match the runtime committee-liveness filter (spec-229).
export const GRACE_BLOCKS = 14_400;
export const WINDOW_BLOCKS = 28_800;

const SLOT_SECONDS = 6;
// Heartbeat node counts as "at tip" within this many blocks of the network head.
const AT_TIP_BLOCKS = 60;
// Finalized lag beyond this many blocks while at tip = GRANDPA room divergence.
const FINALITY_LAG_BLOCKS = 600;
// Heartbeats older than this are treated as a downed node, not a finality signal.
const HEARTBEAT_STALE_SECONDS = 600;

const DOCS_SPO_ONBOARDING =
  "https://docs.fluxpointstudios.com/materios-partner-chain/spo-onboarding";

const SNAPSHOT_GUIDANCE =
  "Bring your node online bootstrapped from the CURRENT public snapshot — do not replay from genesis. Selection resumes automatically once it authors again.";

export interface JourneyHeartbeat {
  bestBlock: number;
  finalizedBlock: number;
  receivedAt: string;
  ageSeconds: number;
}

export interface JourneyInputs {
  now: { bestBlock: number; finalizedBlock: number };
  firstSelected: number | null;
  lastAuthored: number | null;
  inCurrentCommittee: boolean;
  inNextCommittee: boolean;
  registrationSeen: boolean | null;
  heartbeat: JourneyHeartbeat | null;
}

export type MilestoneStatus = "done" | "active" | "pending" | "warning" | "unknown";

export interface Milestone {
  id: "registered" | "selected" | "authoring" | "liveness" | "finality";
  title: string;
  status: MilestoneStatus;
  detail: string;
  guidance?: string;
}

export interface JourneyState {
  milestones: Milestone[];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatBlockAge(blocks: number): string {
  const s = Math.max(0, blocks) * SLOT_SECONDS;
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3_600)}h`;
  return `${Math.round(s / 8_640) / 10}d`;
}

function registeredMilestone(i: JourneyInputs): Milestone {
  if (i.registrationSeen === true) {
    return {
      id: "registered",
      title: "Registered on Cardano L1",
      status: "done",
      detail: "Registration UTxO found at the partner-chain candidates address.",
    };
  }
  if (i.registrationSeen === null) {
    return {
      id: "registered",
      title: "Registered on Cardano L1",
      status: "unknown",
      detail: "not checked — this gateway has no cardano-db-sync configured for L1 registration lookups.",
    };
  }
  return {
    id: "registered",
    title: "Registered on Cardano L1",
    status: "pending",
    detail: "No registration UTxO with this sidechain key seen at the candidates address yet.",
    guidance:
      `Submit your registration on Cardano L1 with the partner-chains CLI, then allow a few minutes for indexing. See ${DOCS_SPO_ONBOARDING}.`,
  };
}

function selectedMilestone(i: JourneyInputs): Milestone {
  if (i.firstSelected !== null) {
    const age = formatBlockAge(i.now.bestBlock - i.firstSelected);
    const membership = i.inCurrentCommittee
      ? "; in the current committee"
      : i.inNextCommittee
        ? "; in the next committee"
        : "";
    return {
      id: "selected",
      title: "Selected into a committee",
      status: "done",
      detail: `First selected at block #${fmt(i.firstSelected)} (~${age} ago)${membership}.`,
    };
  }
  return {
    id: "selected",
    title: "Selected into a committee",
    status: "pending",
    detail: "Not yet selected into any Materios committee.",
    guidance:
      "Selection happens at epoch boundaries (~61 min) once your registration is in a stable Cardano block.",
  };
}

function authoringMilestone(i: JourneyInputs): Milestone {
  const title = "Authoring blocks";
  if (i.lastAuthored !== null) {
    const gap = i.now.bestBlock - i.lastAuthored;
    const detail = `Last block #${fmt(i.lastAuthored)}, ${formatBlockAge(gap)} ago`;
    if (gap <= WINDOW_BLOCKS) {
      return { id: "authoring", title, status: "done", detail: `${detail}.` };
    }
    return {
      id: "authoring",
      title,
      status: "warning",
      detail: `${detail} — beyond the ${fmt(WINDOW_BLOCKS)}-block liveness window.`,
      guidance: SNAPSHOT_GUIDANCE,
    };
  }
  if (i.firstSelected !== null) {
    const sinceSelected = i.now.bestBlock - i.firstSelected;
    if (sinceSelected > GRACE_BLOCKS) {
      return {
        id: "authoring",
        title,
        status: "warning",
        detail:
          "Selected but never authored — your node is being excluded from selection by the liveness filter until it comes online.",
        guidance: SNAPSHOT_GUIDANCE,
      };
    }
    return {
      id: "authoring",
      title,
      status: "active",
      detail: `No blocks yet — within the ${fmt(GRACE_BLOCKS)}-block grace period (${fmt(GRACE_BLOCKS - sinceSelected)} blocks remaining).`,
    };
  }
  return {
    id: "authoring",
    title,
    status: "pending",
    detail: "Authoring starts after the first committee selection.",
  };
}

function livenessMilestone(i: JourneyInputs): Milestone {
  const title = "Liveness filter";
  if (i.lastAuthored !== null && i.now.bestBlock - i.lastAuthored <= WINDOW_BLOCKS) {
    return {
      id: "liveness",
      title,
      status: "done",
      detail: `Active — authored within the last ${fmt(WINDOW_BLOCKS)} blocks; eligible for selection.`,
    };
  }
  if (
    i.lastAuthored === null &&
    i.firstSelected !== null &&
    i.now.bestBlock - i.firstSelected <= GRACE_BLOCKS
  ) {
    return {
      id: "liveness",
      title,
      status: "active",
      detail: `Grace — newly selected; no blocks required for the first ${fmt(GRACE_BLOCKS)} blocks.`,
    };
  }
  if (i.firstSelected === null && i.lastAuthored === null) {
    return {
      id: "liveness",
      title,
      status: "pending",
      detail: "Not applicable — never selected into a committee.",
    };
  }
  return {
    id: "liveness",
    title,
    status: "warning",
    detail: "Evicted — the liveness filter is excluding this validator from new committees.",
    guidance:
      "Bring the node online with the current snapshot; selection resumes automatically, no re-registration needed.",
  };
}

function finalityMilestone(i: JourneyInputs): Milestone {
  const title = "GRANDPA finality";
  const hb = i.heartbeat;
  if (hb === null) {
    return {
      id: "finality",
      title,
      status: "unknown",
      detail: "No heartbeat received from this validator's cert-daemon.",
      guidance: `Enable cert-daemon heartbeats to get a finality verdict — see ${DOCS_SPO_ONBOARDING}.`,
    };
  }
  if (hb.ageSeconds > HEARTBEAT_STALE_SECONDS) {
    return {
      id: "finality",
      title,
      status: "pending",
      detail: `Node offline or heartbeats stopped — last heartbeat ${fmt(Math.round(hb.ageSeconds))}s ago.`,
    };
  }
  if (hb.bestBlock >= i.now.bestBlock - AT_TIP_BLOCKS) {
    if (hb.finalizedBlock < i.now.finalizedBlock - FINALITY_LAG_BLOCKS) {
      return {
        id: "finality",
        title,
        status: "warning",
        detail: `Node is at tip (#${fmt(hb.bestBlock)}) but its finalized block #${fmt(hb.finalizedBlock)} lags the network's #${fmt(i.now.finalizedBlock)}.`,
        guidance:
          "Your node authors but its finality is frozen — GRANDPA voting-room divergence. Fix: stop node, replace chain db with the CURRENT public snapshot, restart. Do NOT replay from genesis.",
      };
    }
    return {
      id: "finality",
      title,
      status: "done",
      detail: `Node at tip (#${fmt(hb.bestBlock)}) and finality tracking the network (finalized #${fmt(hb.finalizedBlock)}).`,
    };
  }
  return {
    id: "finality",
    title,
    status: "pending",
    detail: `Node syncing — ${fmt(i.now.bestBlock - hb.bestBlock)} blocks behind the network tip; finality verdict deferred until at tip.`,
  };
}

export function computeJourney(inputs: JourneyInputs): JourneyState {
  return {
    milestones: [
      registeredMilestone(inputs),
      selectedMilestone(inputs),
      authoringMilestone(inputs),
      livenessMilestone(inputs),
      finalityMilestone(inputs),
    ],
  };
}
