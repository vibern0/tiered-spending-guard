import type { LucideIcon } from "lucide-react";
import {
  Ban,
  CheckCircle2,
  Clock,
  Fingerprint,
  KeyRound,
  Loader2,
  PlayCircle,
  TimerOff,
  XCircle,
} from "lucide-react";

export type Lane = "base" | "step-up" | "delayed" | "blocked";

export type ActivityStatus =
  | "awaiting_first_signer"
  | "awaiting_second_signer"
  | "submitting"
  | "executed"
  | "queued"
  | "ready"
  | "cancelled"
  | "failed"
  | "expired"
  | "unresolved";

export type ActivityItem = {
  id: string;
  kind?: "transfer" | "recipient-addition" | "cancel" | "execute" | "skip" | "unsupported";
  direction: "in" | "out" | "self";
  proposal?: boolean;
  amount: bigint;
  counterparty: string;
  address: string;
  lane: Lane;
  status: ActivityStatus;
  createdAt: number;
  earliestExecution?: number;
  expiresAt?: number;
  canonicalNow?: number;
  txHash?: string;
  queueNonce?: number;
  approvers: string[];
  fingerprint: string;
  failureReason?: string;
};

type Tone = "approval" | "danger" | "success" | "neutral" | "primary";

export const STATUS_META: Record<ActivityStatus, { label: string; tone: Tone; icon: LucideIcon }> =
  {
    awaiting_first_signer: { label: "Awaiting first signer", tone: "approval", icon: Fingerprint },
    awaiting_second_signer: { label: "Awaiting second signer", tone: "approval", icon: KeyRound },
    submitting: { label: "Submitting", tone: "primary", icon: Loader2 },
    executed: { label: "Executed", tone: "success", icon: CheckCircle2 },
    queued: { label: "Queued — waiting", tone: "danger", icon: Clock },
    ready: { label: "Ready to execute", tone: "primary", icon: PlayCircle },
    cancelled: { label: "Cancelled", tone: "neutral", icon: Ban },
    failed: { label: "Failed", tone: "danger", icon: XCircle },
    expired: { label: "Expired", tone: "neutral", icon: TimerOff },
    unresolved: { label: "Outcome unavailable", tone: "neutral", icon: Clock },
  };

export const LANE_COPY: Record<Lane, { title: string; detail: string }> = {
  base: {
    title: "Approve with first signer",
    detail: "Within your everyday limit. Only the first signer is needed.",
  },
  "step-up": {
    title: "Second signer required",
    detail: "Above the first-signer limit. Approve with the first signer, then the second signer.",
  },
  delayed: {
    title: "Available after the waiting period",
    detail:
      "Above your instant limit. Approve with the first and second signers to schedule it — you can cancel before it runs.",
  },
  blocked: { title: "This transfer is not supported", detail: "" },
};

/** Time-dependent states are derived, never trusted from storage. */
export function effectiveStatus(item: ActivityItem, now = Date.now()): ActivityStatus {
  const effectiveNow = item.canonicalNow ?? now;
  if (item.status === "queued" || item.status === "ready") {
    if (item.expiresAt !== undefined && effectiveNow >= item.expiresAt) return "expired";
    if (item.earliestExecution !== undefined && effectiveNow >= item.earliestExecution)
      return "ready";
    return "queued";
  }
  return item.status;
}

export const needsAttention = (s: ActivityStatus) =>
  s === "awaiting_first_signer" ||
  s === "awaiting_second_signer" ||
  s === "queued" ||
  s === "ready" ||
  s === "unresolved";

export function fingerprintOf(parts: (string | number | bigint)[]): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of parts.join("|")) {
    h ^= BigInt(ch.charCodeAt(0));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  const hex = h.toString(16).padStart(16, "0").toUpperCase();
  return hex.match(/.{4}/g)?.join("-") ?? hex;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
