import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Clock, Fingerprint, KeyRound, Ban } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Card, DRow, Details, PrimaryButton, SecondaryButton } from "@/components/wallet/ui";
import { LANE_COPY, fingerprintOf, type Lane } from "@/lib/activity-model";
import { formatUsdc, parseUsdc } from "@/lib/usdc";
import { useApproval } from "@/lib/use-approval";
import { classify, isAddress, shortAddr, useVault, type Recipient } from "@/lib/vault-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/send")({
  head: () => ({
    meta: [
      { title: "Send USDC — USDC Vault" },
      {
        name: "description",
        content: "Send USDC and see exactly which approvals are needed first.",
      },
      { property: "og:title", content: "Send USDC — USDC Vault" },
      {
        property: "og:description",
        content: "Send USDC and see exactly which approvals are needed first.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SendPage,
});

const LANE_ICON: Record<Lane, typeof Fingerprint> = {
  base: Fingerprint,
  "step-up": KeyRound,
  delayed: Clock,
  blocked: Ban,
};

function SendPage() {
  const { state, loading, refresh, sendUsdc } = useVault();
  const nav = useNavigate();
  const { busy } = useApproval();
  const refreshedOnOpen = useRef(false);
  const [step, setStep] = useState<"to" | "amount" | "review">("to");
  const [to, setTo] = useState<Recipient | null>(null);
  const [manual, setManual] = useState("");
  const [amountStr, setAmountStr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const amount = parseUsdc(amountStr);
  const [snapshot, setSnapshot] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (refreshedOnOpen.current) return;
    refreshedOnOpen.current = true;
    void refresh();
  }, [refresh]);

  const pickManual = () => {
    if (!isAddress(manual) || /^0x0{40}$/i.test(manual))
      return setError("That doesn't look like a valid account address.");
    const known = state.recipients.find((r) => r.address.toLowerCase() === manual.toLowerCase());
    setError(null);
    setTo(known ?? { name: shortAddr(manual), address: manual });
    setStep("amount");
  };

  const result = to && amount !== null ? classify(state, to.address, amount) : null;
  const lane = result?.lane;
  const delayMs = Number(state.policy.delaySeconds) * 1000;
  const stateKey = () =>
    [
      state.balance,
      state.spentFirstSigner,
      state.spentInstant,
      state.policy.firstSignerDaily,
      state.policy.instantDaily,
      state.frozen,
      state.activity.length,
    ].join("|");
  const fp =
    to && amount !== null
      ? fingerprintOf([state.chainId, state.safe, to.address, amount, snapshot])
      : "";

  const submit = async () => {
    if (!to || amount === null || !lane || lane === "blocked") return;
    // Re-check right before signing; any drift requires a fresh review.
    if (stateKey() !== snapshot || classify(state, to.address, amount).lane !== lane) {
      setError("Something changed since you reviewed this transfer. Please review it again.");
      setStep("amount");
      return;
    }
    setSubmitting(true);
    try {
      await sendUsdc({ recipient: to.address as `0x${string}`, amount });
      nav({ to: "/activity" });
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "The Safe submission was rejected.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <button
        onClick={() =>
          step === "to" ? nav({ to: "/" }) : setStep(step === "review" ? "amount" : "to")
        }
        className="flex items-center gap-2 pt-6 text-sm font-semibold text-muted-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Back
      </button>
      <h1 className="font-display text-2xl font-bold">
        {step === "to" ? "Send to" : step === "amount" ? `Send to ${to?.name}` : "Review transfer"}
      </h1>
      {error && (
        <p
          role="alert"
          className="flex gap-2 rounded-2xl bg-danger-soft p-3 text-sm text-danger-ink"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden /> {error}
        </p>
      )}

      {step === "to" && (
        <>
          <Card className="p-2">
            {state.recipients.map((r) => (
              <button
                key={r.address}
                onClick={() => {
                  setTo(r);
                  setError(null);
                  setStep("amount");
                }}
                className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left hover:bg-secondary/60"
              >
                <div className="grid size-10 place-items-center rounded-full bg-primary-soft font-semibold text-primary">
                  {r.name[0]}
                </div>
                <div>
                  <p className="font-semibold">{r.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{shortAddr(r.address)}</p>
                </div>
              </button>
            ))}
          </Card>
          <Card className="space-y-3">
            <label htmlFor="addr" className="text-sm font-semibold">
              Or paste an account address
            </label>
            <input
              id="addr"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="0x…"
              className="w-full rounded-xl border border-input bg-background px-4 py-3 font-mono text-sm"
            />
            <SecondaryButton onClick={pickManual}>Continue</SecondaryButton>
          </Card>
        </>
      )}

      {step === "amount" && to && (
        <>
          <Card className="space-y-3">
            <label htmlFor="amt" className="text-sm font-semibold">
              Amount
            </label>
            <div className="flex items-center gap-2 border-b-2 border-primary pb-2">
              <span className="font-display text-sm font-bold">USDC</span>
              <input
                id="amt"
                inputMode="decimal"
                autoFocus
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="0.00"
                className="w-full bg-transparent font-display text-4xl font-bold outline-none"
              />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Available {formatUsdc(state.balance)}</span>
              <Link to="/receive" search={{ mode: "topup" }} className="font-semibold text-primary">
                Need more? Top up
              </Link>
            </div>
          </Card>
          {lane && amount !== null && amount > 0n && (
            <LaneCard
              lane={lane}
              reason={result?.reason}
              delaySeconds={state.policy.delaySeconds}
            />
          )}
          {lane === "blocked" && result?.reason?.includes("add this recipient") && (
            <Link to="/limits" className="block font-semibold text-primary underline">
              Add recipient in Limits &amp; security
            </Link>
          )}
          <PrimaryButton
            disabled={loading || amount === null || amount <= 0n || lane === "blocked"}
            onClick={() => {
              setError(null);
              setSnapshot(stateKey());
              setStep("review");
            }}
          >
            {loading ? "Refreshing account…" : "Review"}
          </PrimaryButton>
        </>
      )}

      {step === "review" && to && amount !== null && lane && (
        <>
          <Card className="space-y-3">
            <p className="text-center font-display text-4xl font-extrabold tabular-nums">
              {formatUsdc(amount)}
            </p>
            <p className="text-center text-muted-foreground">to {to.name}</p>
            <dl className="space-y-2 border-t border-border pt-3 text-sm">
              <DRow k="Full address" v={to.address} />
              <DRow k="Network" v={state.network} />
              <DRow k="Fee" v="Paid by the relay on Sepolia" />
              <DRow
                k="Approvers"
                v={lane === "base" ? "First signer" : `First signer + ${state.secondSignerName}`}
              />
              <DRow
                k="Timing"
                v={
                  lane === "delayed"
                    ? `Earliest ${new Date(Date.now() + delayMs).toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" })}`
                    : "Immediate"
                }
              />
              <DRow k="Fingerprint" v={fp} />
            </dl>
          </Card>
          <LaneCard lane={lane} delaySeconds={state.policy.delaySeconds} />
          <Details>
            <DRow k="Account (Safe)" v={state.safe} />
            <DRow k="Chain ID" v={state.chainId} />
            <DRow k="Call" v={`USDC.transfer(${to.address.slice(0, 10)}…, ${amount.toString()})`} />
          </Details>
          <PrimaryButton onClick={submit} disabled={!!busy || submitting}>
            <Fingerprint className="size-5" aria-hidden />{" "}
            {submitting ? "Signing exact Safe transaction…" : "Approve with first signer"}
          </PrimaryButton>
        </>
      )}
    </div>
  );
}

function LaneCard({
  lane,
  reason,
  delaySeconds,
}: {
  lane: Lane;
  reason?: string | undefined;
  delaySeconds: bigint;
}) {
  const Icon = LANE_ICON[lane];
  const copy = LANE_COPY[lane];
  const tone =
    lane === "base"
      ? "bg-primary-soft text-primary"
      : lane === "step-up"
        ? "bg-approval-soft text-approval-ink"
        : "bg-danger-soft text-danger-ink";
  const delayLabel =
    delaySeconds % 3_600n === 0n
      ? `${delaySeconds / 3_600n} hours`
      : delaySeconds % 60n === 0n
        ? `${delaySeconds / 60n} minutes`
        : `${delaySeconds} seconds`;
  const title = lane === "delayed" ? `Available after ${delayLabel}` : copy.title;
  return (
    <div className={cn("flex gap-3 rounded-2xl p-4", tone)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div>
        <p className="font-semibold">{title}</p>
        <p className="text-sm opacity-90">{reason ?? copy.detail}</p>
      </div>
    </div>
  );
}
