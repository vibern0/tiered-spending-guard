import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import {
  Card,
  PageHeader,
  NetworkPill,
  PrimaryButton,
  SecondaryButton,
} from "@/components/wallet/ui";
import { formatUsdc } from "@/lib/usdc";
import { isAddress, shortAddr, useNow, useVault } from "@/lib/vault-store";
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
  const { state, canWrite, loading, addRecipient } = useVault();
  const [candidate, setCandidate] = useState("");
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const now = useNow();
  const p = state.policy;
  const reviewRecipient = () => {
    const recipient = candidate.trim();
    setError(null);
    setOutcome(null);
    if (!isAddress(recipient) || /^0x0{40}$/i.test(recipient))
      return setError("Enter a valid nonzero recipient address.");
    if (state.recipients.some((entry) => entry.address.toLowerCase() === recipient.toLowerCase()))
      return setError("This recipient is already allowed for elevated transfers.");
    setReviewed(recipient);
  };
  const submitRecipient = async () => {
    if (!reviewed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = await addRecipient(reviewed as `0x${string}`);
      setOutcome(
        status.state === "confirmed"
          ? `Recipient addition queued. Wait ${p.delaySeconds} seconds, then execute it from Activity before it expires. The list changes only after execution.`
          : "Recipient addition submitted. Check Activity for confirmation before continuing.",
      );
      setReviewed(null);
      setCandidate("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Recipient addition failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Limits & security" right={<NetworkPill />} />
      {state.compatibility?.mode === "read-only" && (
        <Card className="space-y-2">
          <p className="text-sm">
            Keep this earlier account and start a separate Sepolia test vault with the current
            recipient policy.
          </p>
          <Link to="/onboarding" className="inline-block font-semibold text-primary underline">
            Start a new test vault
          </Link>
        </Card>
      )}
      <p className="rounded-2xl bg-primary-soft p-3 text-sm font-semibold text-primary">
        Verified onchain policy · limits stay fixed
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
          hint={`Above this, transfers wait ${p.delaySeconds.toString()} seconds and can be cancelled.`}
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
        <p className="mb-3 text-sm text-muted-foreground">
          {state.compatibility?.mode === "read-only"
            ? "Required for all transfers on this earlier vault."
            : "Required for second-signer and delayed transfers. Everyday transfers within X may use any valid nonzero address."}
        </p>
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
      {canWrite && !state.frozen && state.compatibility?.mode !== "read-only" && (
        <Card className="space-y-3">
          <h2 className="font-semibold">Add an elevated recipient</h2>
          <p className="text-sm text-muted-foreground">
            First signer, then second signer. The addition waits {p.delaySeconds.toString()} seconds
            and can be cancelled in Activity.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger-ink">
              {error}
            </p>
          )}
          {outcome && (
            <p role="status" className="text-sm text-primary">
              {outcome}
            </p>
          )}
          {outcome && (
            <Link to="/activity" className="block font-semibold text-primary underline">
              View in Activity
            </Link>
          )}
          {reviewed ? (
            <>
              <p className="text-sm font-semibold">Review delayed recipient addition</p>
              <p className="break-all font-mono text-xs">{reviewed}</p>
              <p className="text-sm text-muted-foreground">
                No transfer is made. Other limits and recipients stay unchanged.
              </p>
              <PrimaryButton disabled={busy || loading} onClick={submitRecipient}>
                {busy ? "Waiting for signer approvals…" : "Approve delayed recipient addition"}
              </PrimaryButton>
              <SecondaryButton disabled={busy} onClick={() => setReviewed(null)}>
                Back to address
              </SecondaryButton>
            </>
          ) : (
            <>
              <label htmlFor="recipient-addition" className="block text-sm font-semibold">
                New recipient address
              </label>
              <input
                id="recipient-addition"
                value={candidate}
                onChange={(event) => {
                  setCandidate(event.target.value);
                  setError(null);
                }}
                placeholder="0x…"
                className="w-full rounded-xl border border-input bg-background px-4 py-3 font-mono text-sm"
              />
              <PrimaryButton disabled={busy || loading} onClick={reviewRecipient}>
                Review recipient addition
              </PrimaryButton>
            </>
          )}
        </Card>
      )}
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
        Active settings are read from the onchain guard. Recipient additions require both signers
        and the waiting period. Other policy changes and freeze controls are not exposed here.
      </p>
      {state.frozen && (
        <p className="text-center text-sm text-danger-ink">
          Frozen — no transfers can be approved.
        </p>
      )}
    </div>
  );
}
