import { createFileRoute } from "@tanstack/react-router";
import { Card, DRow, NetworkPill, PageHeader } from "@/components/wallet/ui";
import { useVault } from "@/lib/vault-store";

export const Route = createFileRoute("/profile")({ component: ProfilePage });

function ProfilePage() {
  const { state, setup } = useVault();
  return (
    <div className="space-y-4">
      <PageHeader title="Vault profile" right={<NetworkPill />} />
      <Card className="space-y-2 text-sm">
        <DRow k="Network" v={`${state.network} · ${state.chainId}`} />
        <DRow k="Safe" v={state.safe} />
        <DRow k="Guard" v={state.guard} />
        <DRow k="Delay" v={state.delay} />
        <DRow
          k="First signer"
          v={setup.primaryCredentialId ? "Platform passkey registered" : "Not registered"}
        />
        <DRow
          k="Second signer"
          v={setup.secondaryCredentialId ? state.secondSignerName : "Not registered"}
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
