import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Circle, Fingerprint, KeyRound, ShieldCheck, ListChecks } from "lucide-react";
import { useState } from "react";
import { Card, DRow, PrimaryButton, NetworkPill } from "@/components/wallet/ui";
import { formatUsdc } from "@/lib/usdc";
import { describeProvisioningError } from "@/lib/provisioning-errors";
import { useVault, type Onboarding } from "@/lib/vault-store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Set up your account — USDC Vault" },
      {
        name: "description",
        content: "Register two passkeys and provision a reviewed Sepolia vault.",
      },
    ],
  }),
  component: OnboardingPage,
});

const STEPS: { key: keyof Onboarding; title: string; icon: typeof Fingerprint }[] = [
  { key: "firstSigner", title: "Set up first signer", icon: Fingerprint },
  { key: "secondSigner", title: "Set up second signer", icon: KeyRound },
  { key: "limits", title: "Review and provision", icon: ShieldCheck },
  { key: "rehearsed", title: "Safety rehearsal", icon: ListChecks },
];
const EXERCISES = [
  "Everyday transfer",
  "Second-signer approval",
  "Scheduled withdrawal",
  "Cancellation",
];

export function OnboardingPage() {
  const {
    state,
    setup,
    loading,
    registerPrimary,
    registerSecondary,
    retryProvisioning,
    rebindPrimary,
    rebindSecondary,
    finishSetup,
  } = useVault();
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exercises, setExercises] = useState<string[]>([]);
  const progress: Onboarding = {
    firstSigner: Boolean(setup.primaryCredentialId),
    secondSigner: Boolean(setup.secondaryCredentialId),
    limits: setup.provisioning === "provisioned",
    rehearsed: state.onboarding.rehearsed,
  };
  const current = STEPS.find((step) => !progress[step.key])?.key;
  const run = async (label: string, action: () => Promise<void>) => {
    setErr(null);
    setBusy(label);
    try {
      await action();
    } catch (error) {
      setErr(describeProvisioningError(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 pt-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-2xl font-bold">Set up your account</h1>
        <NetworkPill />
      </div>
      <p className="text-sm text-muted-foreground">
        Public credential references and progress are stored for this exact environment. Assertions
        and signatures are never stored.
      </p>
      <p className="rounded-2xl bg-danger-soft p-3 text-sm font-semibold text-danger-ink">
        Sepolia prototype · no signer recovery · no independent notification delivery
      </p>
      {err && (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-sm text-danger-ink">
          {err}
        </p>
      )}
      {setup.secondaryCredentialId && !setup.distinctSecondary && (
        <p className="rounded-xl bg-approval-soft p-3 text-sm text-approval-ink">
          Same-device second signer detected. This does not provide device separation; use a
          cross-platform authenticator where possible.
        </p>
      )}

      {STEPS.map((step, index) => {
        const done = progress[step.key];
        const active = current === step.key;
        return (
          <Card key={step.key} className={cn(!active && "opacity-80")}>
            <div className="flex items-center gap-3">
              {done ? (
                <CheckCircle2 className="size-6 text-success" aria-label="Done" />
              ) : (
                <Circle className="size-6 text-muted-foreground" aria-label="Not done" />
              )}
              <span className="font-semibold">
                {index + 1}. {step.title}
              </span>
            </div>
            {active && (
              <div className="mt-4 space-y-3">
                {step.key === "firstSigner" && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Register the platform passkey used for the base tier.
                    </p>
                    <PrimaryButton
                      disabled={loading || busy !== null}
                      onClick={() => run("primary", registerPrimary)}
                    >
                      <Fingerprint className="size-5" aria-hidden />
                      {busy === "primary" ? "Waiting for first signer…" : "Register first signer"}
                    </PrimaryButton>
                  </>
                )}
                {step.key === "secondSigner" && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Use a distinct cross-platform authenticator where possible. A same-device
                      passkey does not provide device separation.
                    </p>
                    <PrimaryButton
                      disabled={busy !== null}
                      onClick={() => run("secondary", registerSecondary)}
                    >
                      <KeyRound className="size-5" aria-hidden />
                      {busy === "secondary"
                        ? "Waiting for second signer…"
                        : "Register second signer"}
                    </PrimaryButton>
                  </>
                )}
                {step.key === "limits" && (
                  <>
                    <p className="text-sm font-semibold">Verified Phase One policy (read-only)</p>
                    <dl className="space-y-2 text-sm">
                      <DRow
                        k="First-signer daily X"
                        v={formatUsdc(state.policy.firstSignerDaily)}
                      />
                      <DRow
                        k="Combined instant daily Y"
                        v={formatUsdc(state.policy.instantDaily)}
                      />
                      <DRow k="Delay Z" v={`${state.policy.delaySeconds.toString()} seconds`} />
                      <DRow
                        k="Second signer"
                        v={setup.distinctSecondary ? "Cross-platform" : "Same-device"}
                      />
                    </dl>
                    {setup.provisioning === "provisioning" && (
                      <p className="rounded-xl bg-approval-soft p-3 text-sm text-approval-ink">
                        {setup.credentialRebind.required
                          ? "Deployment verified. Verify both existing signers to unlock vault actions."
                          : "Provisioning and verifying… Keep this page open while seven bounded Sepolia transactions confirm."}
                      </p>
                    )}
                    {setup.credentialRebind.primary === "required" && (
                      <PrimaryButton disabled={busy !== null} onClick={() => run("rebind-primary", rebindPrimary)}>
                        <Fingerprint className="size-5" aria-hidden />
                        {busy === "rebind-primary" ? "Verifying first signer…" : "Verify first signer"}
                      </PrimaryButton>
                    )}
                    {setup.credentialRebind.primary === "ready" && setup.credentialRebind.secondary === "required" && (
                      <PrimaryButton disabled={busy !== null} onClick={() => run("rebind-secondary", rebindSecondary)}>
                        <KeyRound className="size-5" aria-hidden />
                        {busy === "rebind-secondary" ? "Verifying second signer…" : "Verify second signer"}
                      </PrimaryButton>
                    )}
                    {setup.provisioning === "failed" && !setup.credentialRebind.required && (
                      <PrimaryButton
                        disabled={busy !== null}
                        onClick={() => run("retry", retryProvisioning)}
                      >
                        {busy === "retry" ? "Provisioning and verifying…" : "Retry automatic provisioning"}
                      </PrimaryButton>
                    )}
                  </>
                )}
                {step.key === "rehearsed" && (
                  <>
                    <dl className="space-y-1 text-sm">
                      <DRow k="Account" v={state.safe} />
                      <DRow k="First signer" v="Active" />
                      <DRow k="Second signer" v={state.secondSignerName} />
                      <DRow k="Network" v={state.network} />
                      <DRow k="Provisioning receipt" v={setup.receiptHash ?? "—"} />
                    </dl>
                    <p className="pt-2 text-sm font-semibold">
                      Acknowledge the supported safety journeys
                    </p>
                    {EXERCISES.map((exercise) => (
                      <label key={exercise} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={exercises.includes(exercise)}
                          onChange={(event) =>
                            setExercises(
                              event.target.checked
                                ? [...exercises, exercise]
                                : exercises.filter((value) => value !== exercise),
                            )
                          }
                          className="size-4 accent-[var(--primary)]"
                        />
                        {exercise}
                      </label>
                    ))}
                    <PrimaryButton
                      disabled={exercises.length < EXERCISES.length}
                      onClick={() => {
                        finishSetup();
                        nav({ to: "/" });
                      }}
                    >
                      Finish setup
                    </PrimaryButton>
                  </>
                )}
              </div>
            )}
          </Card>
        );
      })}
      {setup.provisioning === "provisioned" && (
        <Card className="space-y-2">
          <h2 className="font-semibold">Fund the test vault</h2>
          <p className="text-sm text-muted-foreground">
            Use the Circle Sepolia faucet manually, then send test USDC to the verified Safe
            address. Never send mainnet assets.
          </p>
          <Link to="/receive" search={{ mode: "topup" }} className="font-semibold text-primary">
            Show Safe address and faucet instructions
          </Link>
        </Card>
      )}
      {!current && <PrimaryButton onClick={() => nav({ to: "/" })}>Go to account</PrimaryButton>}
    </div>
  );
}
