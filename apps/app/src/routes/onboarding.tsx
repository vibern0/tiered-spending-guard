import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Circle, Fingerprint, KeyRound, ShieldCheck, ListChecks } from "lucide-react";
import { useState } from "react";
import { Card, DRow, PrimaryButton, NetworkPill } from "@/components/wallet/ui";
import { formatUsdc, parseUsdc } from "@/lib/usdc";
import { describeProvisioningError } from "@/lib/provisioning-errors";
import { useApproval } from "@/lib/use-approval";
import { useVault, type Onboarding } from "@/lib/vault-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Set up your account — USDC Vault" },
      { name: "description", content: "Set up your first and second signers, protection limits, and safety rehearsal." },
      { property: "og:title", content: "Set up your account — USDC Vault" },
      { property: "og:description", content: "Set up your first and second signers, protection limits, and safety rehearsal." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: OnboardingPage,
});

const STEPS: { key: keyof Onboarding; title: string; icon: typeof Fingerprint }[] = [
  { key: "firstSigner", title: "Set up first signer", icon: Fingerprint },
  { key: "secondSigner", title: "Set up second signer", icon: KeyRound },
  { key: "limits", title: "Set protection limits", icon: ShieldCheck },
  { key: "rehearsed", title: "Review and rehearse", icon: ListChecks },
];

const EXERCISES = ["Everyday transfer", "Second-signer approval", "Scheduled withdrawal", "Notification", "Cancellation", "Recovery"];

function OnboardingPage() {
  const { state, provision, loading, finishSetup } = useVault();
  const nav = useNavigate();
  const { busy, approve } = useApproval();
  const ob = state.onboarding;
  const current = STEPS.find((s) => !ob[s.key])?.key;
  const done = (k: keyof Onboarding) => {
    if (k !== "rehearsed") return;
    finishSetup();
  };

  const [x, setX] = useState(formatUsdc(state.policy.firstSignerDaily).slice(1));
  const [y, setY] = useState(formatUsdc(state.policy.instantDaily).slice(1));
  const [cap, setCap] = useState(formatUsdc(state.policy.perTxCap).slice(1));
  const [z, setZ] = useState(String(state.policy.delayHours));
  const [err, setErr] = useState<string | null>(null);
  const [ex, setEx] = useState<string[]>([]);
  const [provisioning, setProvisioning] = useState(false);

  const createPasskeyVault = async () => {
    setErr(null);
    setProvisioning(true);
    try {
      await provision();
    } catch (error) {
      setErr(describeProvisioningError(error));
    } finally {
      setProvisioning(false);
    }
  };

  const saveLimits = () => {
    const X = parseUsdc(x), Y = parseUsdc(y), C = parseUsdc(cap), Z = Number(z);
    if (X === null || Y === null || C === null) return setErr("Enter valid usdc amounts.");
    if (!(X > 0n && X < Y)) return setErr("First-signer limit must be above 0 USDC and below the instant limit.");
    if (C < Y) return setErr("The per-transfer maximum must be at least the instant limit.");
    if (!Number.isInteger(Z) || Z < 1 || Z > 168) return setErr("Waiting period must be 1–168 hours.");
    setErr(null);
    setErr("Limits are read from the verified onchain guard. Change requests use the delayed policy flow.");
  };

  const field = (id: string, label: string, v: string, set: (s: string) => void, suffix = "USDC") => (
    <label htmlFor={id} className="block text-sm">
      <span className="font-semibold">{label}</span>
      <div className="mt-1 flex items-center rounded-xl border border-input bg-background px-3">
        <span className="text-muted-foreground">{suffix}</span>
        <input id={id} value={v} onChange={(e) => set(e.target.value)} inputMode="decimal" className="w-full bg-transparent px-2 py-3 outline-none" />
      </div>
    </label>
  );

  return (
    <div className="space-y-4 pt-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">Set up your account</h1>
        <NetworkPill />
      </div>
      <p className="text-sm text-muted-foreground">Your progress is saved. No passwords, keys or PINs are stored here.</p>

      {STEPS.map((s, i) => {
        const isDone = ob[s.key];
        const isCurrent = current === s.key;
        return (
          <Card key={s.key} className={cn(!isCurrent && "opacity-80")}>
            <div className="flex items-center gap-3">
              {isDone ? <CheckCircle2 className="size-6 text-success" aria-label="Done" /> : <Circle className="size-6 text-muted-foreground" aria-label="Not done" />}
              <span className="font-semibold">{i + 1}. {s.title}</span>
            </div>
            {isCurrent && (
              <div className="mt-4 space-y-3">
                {s.key === "firstSigner" && (
                  <>
                    <p className="text-sm text-muted-foreground">Your first signer approves everyday transfers. Its method depends on the signer you connect.</p>
                    <PrimaryButton disabled={loading || provisioning || !!busy} onClick={createPasskeyVault} aria-busy={provisioning}>
                      <Fingerprint className="size-5" aria-hidden /> {loading ? "Reading vault…" : provisioning ? "Creating passkey vault…" : "Create passkey vault"}
                    </PrimaryButton>
                    {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-ink">{err}</p>}
                  </>
                )}
                {s.key === "secondSigner" && (
                  <>
                    <p className="text-sm text-muted-foreground">Your second signer adds approval for larger and delayed transfers. It may use a security key, wallet, or another supported method.</p>
                    <PrimaryButton disabled={true} onClick={async () => { await approve("second"); }}>
                      <KeyRound className="size-5" aria-hidden /> {busy ? "Waiting for second signer…" : "Set up second signer"}
                    </PrimaryButton>
                  </>
                )}
                {s.key === "limits" && (
                  <>
                    {field("x", "First-signer daily limit", x, setX)}
                    {field("y", "Instant daily limit", y, setY)}
                    {field("cap", "Maximum per transfer", cap, setCap)}
                    {field("z", "Waiting period (hours)", z, setZ, "h")}
                    {err && <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-ink">{err}</p>}
                    <PrimaryButton onClick={saveLimits}>Save limits</PrimaryButton>
                  </>
                )}
                {s.key === "rehearsed" && (
                  <>
                    <dl className="space-y-1 text-sm">
                      <DRow k="Account" v={state.safe} />
                      <DRow k="First signer" v="Active" />
                      <DRow k="Second signer" v={state.secondSignerName} />
                      <DRow k="Limits" v={`${formatUsdc(state.policy.firstSignerDaily)} / ${formatUsdc(state.policy.instantDaily)}`} />
                      <DRow k="Waiting period" v={`${state.policy.delayHours} h`} />
                      <DRow k="Network" v={state.network} />
                    </dl>
                    <p className="pt-2 text-sm font-semibold">Practise each safety step</p>
                    {EXERCISES.map((e) => (
                      <label key={e} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" checked={ex.includes(e)} onChange={(ev) => setEx(ev.target.checked ? [...ex, e] : ex.filter((v) => v !== e))} className="size-4 accent-[var(--primary)]" />
                        {e}
                      </label>
                    ))}
                    <PrimaryButton disabled={ex.length < EXERCISES.length} onClick={() => { done("rehearsed"); nav({ to: "/" }); }}>
                      Finish setup
                    </PrimaryButton>
                  </>
                )}
              </div>
            )}
          </Card>
        );
      })}
      {!current && <PrimaryButton onClick={() => nav({ to: "/" })}>Go to account</PrimaryButton>}
    </div>
  );
}
