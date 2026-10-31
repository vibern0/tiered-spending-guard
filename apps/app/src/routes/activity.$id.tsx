import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Card, DRow, Details, PrimaryButton, SecondaryButton, StatusBadge } from "@/components/wallet/ui";
import { LANE_COPY, effectiveStatus, formatCountdown } from "@/lib/activity-model";
import { formatUsdc } from "@/lib/usdc";
import { useNow, useVault } from "@/lib/vault-store";

export const Route = createFileRoute("/activity/$id")({
  head: () => ({
    meta: [
      { title: "Transfer details — USDC Vault" },
      { name: "description", content: "Status, approvals and technical details for one transfer." },
      { property: "og:title", content: "Transfer details — USDC Vault" },
      { property: "og:description", content: "Status, approvals and technical details for one transfer." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DetailPage,
});

const fmt = (t?: number) => (t ? new Date(t).toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" }) : "—");

function DetailPage() {
  const { id } = Route.useParams();
  const { state } = useVault();
  const now = useNow(10_000);
  const nav = useNavigate();
  const item = state.activity.find((a) => a.id === id);

  if (!item)
    return (
      <div className="pt-16 text-center">
        <p className="font-semibold">Transfer not found</p>
        <Link to="/activity" className="mt-4 inline-block text-primary">Back to activity</Link>
      </div>
    );

  const status = effectiveStatus(item, now);
  const onUnavailable = () => undefined;

  return (
    <div className="space-y-4">
      <button onClick={() => nav({ to: "/activity" })} className="flex items-center gap-2 pt-6 text-sm font-semibold text-muted-foreground">
        <ArrowLeft className="size-4" aria-hidden /> Activity
      </button>

      <Card className="text-center">
        <p className="text-sm text-muted-foreground">{item.direction === "in" ? "From" : "To"} {item.counterparty}</p>
        <p className="my-2 font-display text-4xl font-extrabold tabular-nums">
          {item.direction === "in" ? "+" : "−"}
          {formatUsdc(item.amount)}
        </p>
        <StatusBadge status={status} />
        {status === "queued" && item.earliestExecution && (
          <p className="mt-3 text-sm text-danger-ink">
            Scheduled withdrawal. Runs in {formatCountdown(item.earliestExecution - now)} unless you cancel it.
          </p>
        )}
        {(status === "awaiting_first_signer" || status === "awaiting_second_signer") && (
          <p className="mt-3 text-sm text-approval-ink">Not yet approved — nothing will be sent until you approve.</p>
        )}
        {item.failureReason && <p className="mt-3 text-sm text-danger-ink">{item.failureReason}</p>}
      </Card>

      {item.direction === "out" && <p className="px-1 text-sm text-muted-foreground">{LANE_COPY[item.lane].title}</p>}

      <div className="space-y-3">
        {status === "awaiting_first_signer" && (
          <PrimaryButton onClick={onUnavailable} disabled>Approve with first signer</PrimaryButton>
        )}
        {status === "awaiting_second_signer" && (
          <PrimaryButton onClick={onUnavailable} disabled>Approve with {state.secondSignerName}</PrimaryButton>
        )}
        {status === "ready" && (
          <PrimaryButton onClick={onUnavailable} disabled>
            Execute withdrawal
          </PrimaryButton>
        )}
        {(status === "queued" || status === "ready" || status === "awaiting_first_signer" || status === "awaiting_second_signer") && (
          <SecondaryButton onClick={onUnavailable} disabled className="bg-danger-soft text-danger-ink hover:bg-danger-soft/70">
            {status === "queued" || status === "ready" ? "Cancel withdrawal" : "Discard request"}
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
        <DRow k="Call" v={`USDC.transfer(${item.address.slice(0, 10)}…, ${item.amount.toString()})`} />
        <DRow k="Fingerprint" v={item.fingerprint} />
      </Details>
    </div>
  );
}
