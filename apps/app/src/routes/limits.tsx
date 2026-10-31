import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { Card, PageHeader, NetworkPill } from "@/components/wallet/ui";
import { formatUsdc } from "@/lib/usdc";
import { shortAddr, useNow, useVault } from "@/lib/vault-store";
import { formatCountdown } from "@/lib/activity-model";

export const Route = createFileRoute("/limits")({
  head: () => ({
    meta: [
      { title: "Limits & security — USDC Vault" },
      {
        name: "description",
        content: "Daily limits, waiting period, allowed recipients and approval devices.",
      },
      { property: "og:title", content: "Limits & security — USDC Vault" },
      {
        property: "og:description",
        content: "Daily limits, waiting period, allowed recipients and approval devices.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LimitsPage,
});

function Usage({
  label,
  used,
  limit,
  hint,
}: {
  label: string;
  used: bigint;
  limit: bigint;
  hint: string;
}) {
  const pct = limit > 0n ? Number((used * 100n) / limit) : 0;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="font-semibold">{label}</span>
        <span className="tabular-nums">
          {formatUsdc(used)} of {formatUsdc(limit)}
        </span>
      </div>
      <div
        className="mt-2 h-2.5 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-valuenow={Math.min(pct, 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function LimitsPage() {
  const { state } = useVault();
  const now = useNow();
  const p = state.policy;
  return (
    <div className="space-y-4">
      <PageHeader title="Limits & security" right={<NetworkPill />} />
      <p className="rounded-2xl bg-primary-soft p-3 text-sm font-semibold text-primary">
        Verified onchain policy · read-only in Phase One
      </p>
      <Card className="space-y-5">
        <Usage
          label="First signer today"
          used={state.spentFirstSigner}
          limit={p.firstSignerDaily}
          hint="Above this, your second signer is also needed."
        />
        <Usage
          label="Instant today"
          used={state.spentInstant}
          limit={p.instantDaily}
          hint={`Above this, transfers wait ${p.delayHours} hours and can be cancelled.`}
        />
        <p className="text-sm text-muted-foreground">
          Resets in {formatCountdown(state.resetsAt - now)}
        </p>
      </Card>
      <Card className="space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">First-signer maximum per transfer</span>
          <span className="font-semibold">{formatUsdc(p.basePerTxCap)}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Second-signer maximum per transfer</span>
          <span className="font-semibold">{formatUsdc(p.perTxCap)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Waiting period</span>
          <span className="font-semibold">{p.delaySeconds.toString()} seconds</span>
        </div>
      </Card>
      <Card>
        <h2 className="mb-2 font-semibold">Allowed recipients</h2>
        <ul className="space-y-2 text-sm">
          {state.recipients.map((r) => (
            <li key={r.address} className="flex min-w-0 justify-between gap-3">
              <span className="min-w-0 truncate">{r.name}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {shortAddr(r.address)}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="space-y-3">
        <h2 className="font-semibold">Approval devices</h2>
        {[
          ["First signer", state.onboarding.firstSigner],
          [state.secondSignerName, state.onboarding.secondSigner],
        ].map(([n, ok]) => (
          <div key={String(n)} className="flex items-center justify-between text-sm">
            <span>{n}</span>
            <span
              className={
                ok
                  ? "flex items-center gap-1 font-semibold text-success"
                  : "font-semibold text-approval-ink"
              }
            >
              {ok ? (
                <>
                  <CheckCircle2 className="size-4" aria-hidden /> Active
                </>
              ) : (
                "Not set up"
              )}
            </span>
          </div>
        ))}
      </Card>
      <p className="text-center text-xs text-muted-foreground">
        Active settings are read from the onchain guard. Policy changes and freeze controls are not
        exposed by this Phase One PWA.
      </p>
      {state.frozen && (
        <p className="text-center text-sm text-danger-ink">
          Frozen — no transfers can be approved.
        </p>
      )}
    </div>
  );
}
