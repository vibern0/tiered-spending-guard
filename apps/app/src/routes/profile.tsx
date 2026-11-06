import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Card, DRow, NetworkPill, PageHeader, PrimaryButton } from "@/components/wallet/ui";
import { useVault } from "@/lib/vault-store";

export const Route = createFileRoute("/profile")({ component: ProfilePage });

function ProfilePage() {
  const { state, setup, sessionManaged, authenticated, accountId, signIn, signOut, createAccount } =
    useVault();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const run = async (action: () => Promise<void>, onboarding = false) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      if (onboarding) await nav({ to: "/onboarding" });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Account action failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Vault profile" right={<NetworkPill />} />
      {sessionManaged && (
        <Card className="space-y-3">
          <p>
            {authenticated
              ? "Signed in with your first passkey"
              : "Sign in to open your vault account"}
          </p>
          {accountId && <DRow k="Account" v={accountId} />}
          {error && <p role="alert">{error}</p>}
          {authenticated ? (
            <PrimaryButton disabled={busy} onClick={() => run(signOut, true)}>
              Sign out
            </PrimaryButton>
          ) : (
            <PrimaryButton disabled={busy} onClick={() => run(signIn)}>
              Sign in with passkey
            </PrimaryButton>
          )}
          <PrimaryButton disabled={busy} onClick={() => run(createAccount, true)}>
            Create account
          </PrimaryButton>
          <p className="text-sm text-muted-foreground">
            Creating another account signs you out and starts a separate test vault. Your existing
            account stays available through its first passkey.
          </p>
        </Card>
      )}
      <Card className="space-y-2 text-sm">
        <DRow k="Network" v={`${state.network} · ${state.chainId}`} />
        <DRow k="Safe" v={state.safe} />
        <DRow k="Guard" v={state.guard} />
        <DRow k="Delay" v={state.delay} />
        <DRow
          k="First signer"
          v={setup.primaryCredentialId ? "First passkey registered" : "Not registered"}
        />
        <DRow
          k="Second signer"
          v={
            setup.secondaryCredentialId || setup.reviewedPlanBound
              ? state.secondSignerName
              : "Not registered"
          }
        />
        <DRow k="Provisioning receipt" v={setup.receiptHash ?? "—"} />
      </Card>
      <p className="text-sm text-muted-foreground">
        This page is read-only. It displays public identifiers only; passkey assertions, signatures,
        private keys, and recovery material are not stored here.
      </p>
    </div>
  );
}
