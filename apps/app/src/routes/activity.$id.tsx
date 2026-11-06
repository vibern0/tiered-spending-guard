import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import {
  Card,
  DRow,
  Details,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
} from "@/components/wallet/ui";
import { LANE_COPY, effectiveStatus, formatCountdown } from "@/lib/activity-model";
import { formatUsdc } from "@/lib/usdc";
import { useNow, useVault } from "@/lib/vault-store";

export const Route = createFileRoute("/activity/$id")({
  head: () => ({
    meta: [
      { title: "Transfer details — USDC Vault" },
      { name: "description", content: "Status, approvals and technical details for one transfer." },
      { property: "og:title", content: "Transfer details — USDC Vault" },
      {
        property: "og:description",
        content: "Status, approvals and technical details for one transfer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DetailPage,
});

const fmt = (t?: number) =>
  t ? new Date(t).toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" }) : "—";

function DetailPage() {
  const { id } = Route.useParams();
  const { state, cancelQueued, executeReady } = useVault();
  const now = useNow(10_000);
  const nav = useNavigate();
  const item = state.activity.find((a) => a.id === id);
  const [busy, setBusy] = useState<"cancel" | "execute" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!item)
    return (
      <div className="pt-16 text-center">
        <p className="font-semibold">Transfer not found</p>
        <Link to="/activity" className="mt-4 inline-block text-primary">
          Back to activity
        </Link>
      </div>
    );

  const status = effectiveStatus(item, now);
  const policyChange = item.kind === "recipient-addition";
  const unsupported = item.kind === "unsupported";
  const displayNow = item.canonicalNow ?? now;
  const run = async (kind: "cancel" | "execute") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "cancel") await cancelQueued(item);
      else await executeReady(item);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Lifecycle action failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => nav({ to: "/activity" })}
        className="flex items-center gap-2 pt-6 text-sm font-semibold text-muted-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Activity
      </button>

      <Card className="text-center">
        <p className="text-sm text-muted-foreground">
          {policyChange
            ? "Delayed recipient addition"
            : unsupported
              ? "Unsupported delayed operation"
              : `${item.direction === "in" ? "From" : "To"} ${item.counterparty}`}
        </p>
        <p className="my-2 font-display text-4xl font-extrabold tabular-nums">
          {policyChange
            ? "Policy change"
            : unsupported
              ? "Review required"
              : `${item.direction === "in" ? "+" : "−"}${formatUsdc(item.amount)}`}
        </p>
        <StatusBadge status={status} />
        {status === "queued" && item.earliestExecution && (
          <p className="mt-3 text-sm text-danger-ink">
            {policyChange ? "Recipient addition" : "Scheduled withdrawal"} can be executed in{" "}
            {formatCountdown(item.earliestExecution - displayNow)} unless you cancel it.
          </p>
        )}
        {(status === "awaiting_first_signer" || status === "awaiting_second_signer") && (
          <p className="mt-3 text-sm text-approval-ink">
            Not yet approved — nothing will be sent until you approve.
          </p>
        )}
        {item.failureReason && <p className="mt-3 text-sm text-danger-ink">{item.failureReason}</p>}
      </Card>

      {policyChange && (
        <p className="px-1 text-sm text-muted-foreground">
          Both signers approved this addition. Execute it after the waiting period to update the
          allowed recipients.
        </p>
      )}
      {item.direction === "out" && !policyChange && !unsupported && (
        <p className="px-1 text-sm text-muted-foreground">{LANE_COPY[item.lane].title}</p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-ink">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {status === "awaiting_first_signer" && (
          <PrimaryButton disabled>Approve with first signer</PrimaryButton>
        )}
        {status === "awaiting_second_signer" && (
          <PrimaryButton disabled>Approve with {state.secondSignerName}</PrimaryButton>
        )}
        {status === "ready" && (
          <PrimaryButton onClick={() => run("execute")} disabled={busy !== null || unsupported}>
            {busy === "execute"
              ? "Executing from verified queue…"
              : policyChange
                ? "Execute recipient addition"
                : "Execute withdrawal"}
          </PrimaryButton>
        )}
        {status === "expired" && (
          <PrimaryButton onClick={() => run("execute")} disabled={busy !== null}>
            {busy === "execute" ? "Skipping expired item…" : "Skip expired queue item"}
          </PrimaryButton>
        )}
        {(status === "queued" ||
          status === "ready" ||
          status === "awaiting_first_signer" ||
          status === "awaiting_second_signer") && (
          <SecondaryButton
            onClick={() => run("cancel")}
            disabled={busy !== null || (status !== "queued" && status !== "ready")}
            className="bg-danger-soft text-danger-ink hover:bg-danger-soft/70"
          >
            {status === "queued" || status === "ready"
              ? policyChange
                ? "Cancel recipient addition"
                : "Cancel withdrawal"
              : "Discard request"}
          </SecondaryButton>
        )}
      </div>

      <Card className="space-y-2 text-sm">
        <DRow k="Created" v={fmt(item.createdAt)} />
        {item.earliestExecution && <DRow k="Earliest execution" v={fmt(item.earliestExecution)} />}
        {item.expiresAt && <DRow k="Expires" v={fmt(item.expiresAt)} />}
        <DRow k="Approved by" v={item.approvers.join(", ") || "—"} />
      </Card>

      <Details>
        <DRow k="Account (Safe)" v={state.safe} />
        <DRow k="Network" v={`${state.network} · ${state.chainId}`} />
        <DRow k="Counterparty" v={item.address} />
        <DRow k="Transaction hash" v={item.txHash ?? "—"} />
        <DRow k="Queue nonce" v={item.queueNonce ?? "—"} />
        <DRow
          k="Call"
          v={
            policyChange
              ? `Delayed addition of ${item.address}`
              : unsupported
                ? "Unrecognized queued operation"
                : `USDC.transfer(${item.address.slice(0, 10)}…, ${item.amount.toString()})`
          }
        />
        <DRow k="Fingerprint" v={item.fingerprint} />
      </Details>
    </div>
  );
}
