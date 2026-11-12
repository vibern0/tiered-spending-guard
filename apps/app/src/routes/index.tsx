import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Plus,
  RefreshCw,
} from "lucide-react";
import { ActivityRow, Card, NetworkPill } from "@/components/wallet/ui";
import { TopologyAlert } from "@/components/wallet/topology-alert";
import { effectiveStatus, needsAttention } from "@/lib/activity-model";
import { formatUsdc } from "@/lib/usdc";
import { displayedFirstSignerSpend } from "@/lib/usage";
import { useNow, useVault } from "@/lib/vault-store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home — USDC Vault" },
      {
        name: "description",
        content: "Your Sepolia USDC balance, quick actions and recent activity.",
      },
      { property: "og:title", content: "Home — USDC Vault" },
      {
        property: "og:description",
        content: "Your Sepolia USDC balance, quick actions and recent activity.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomePage,
});

function HomePage() {
  const { state, canWrite, loading, refresh } = useVault();
  const now = useNow();
  const ob = state.onboarding;
  const setupDone = ob.firstSigner && ob.secondSigner && ob.limits && ob.rehearsed;
  const sorted = [...state.activity].sort((a, b) => b.createdAt - a.createdAt);
  const attention = sorted.filter((i) => needsAttention(effectiveStatus(i, now))).length;
  const funded = state.balance > 0n;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between pt-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-full bg-foreground font-bold text-background">
            B
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Hello</p>
            <p className="font-semibold">Personal account</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Refresh account"
            disabled={loading}
            onClick={() => void refresh()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </button>
          <NetworkPill />
        </div>
      </header>

      {!setupDone && (
        <Link
          to="/onboarding"
          className="flex items-center justify-between rounded-2xl bg-primary-soft p-4 font-semibold text-primary"
        >
          Finish setting up your account
          <ChevronRight className="size-5" aria-hidden />
        </Link>
      )}

      <TopologyAlert />

      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Balance</p>
        <p className="mt-1 font-display text-4xl font-extrabold tabular-nums tracking-tight">
          {formatUsdc(state.balance)}
        </p>
        {funded ? (
          <div className="mt-6 grid grid-cols-2 gap-3">
            <Link
              to="/send"
              aria-disabled={!canWrite}
              className="flex items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 font-semibold text-primary-foreground aria-disabled:pointer-events-none aria-disabled:opacity-50"
            >
              <ArrowUpRight className="size-5" aria-hidden /> Send
            </Link>
            <Link
              to="/receive"
              className="flex items-center justify-center gap-2 rounded-2xl bg-primary-soft py-3.5 font-semibold text-primary"
            >
              <ArrowDownLeft className="size-5" aria-hidden /> Receive
            </Link>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <p className="text-sm">Add test USDC to get started</p>
            <Link
              to="/receive"
              search={{ mode: "topup" }}
              className="flex items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 font-semibold text-primary-foreground"
            >
              <Plus className="size-5" aria-hidden /> Top up
            </Link>
          </div>
        )}
      </Card>

      {state.safe && (
        <Card className="grid grid-cols-2 gap-3 p-4 text-sm">
          <div>
            <p className="text-muted-foreground">Native gas</p>
            <p className="font-semibold tabular-nums">{state.nativeBalance.toString()} wei</p>
          </div>
          <div>
            <p className="text-muted-foreground">Safe nonce</p>
            <p className="font-semibold tabular-nums">{state.safeNonce?.toString() ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground">First signer today</p>
            <p className="font-semibold tabular-nums">
              {formatUsdc(displayedFirstSignerSpend(state))} /{" "}
              {formatUsdc(state.policy.firstSignerDaily)}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Instant today</p>
            <p className="font-semibold tabular-nums">
              {formatUsdc(state.spentInstant)} / {formatUsdc(state.policy.instantDaily)}
            </p>
          </div>
        </Card>
      )}

      {attention > 0 && (
        <Link
          to="/activity"
          search={{ filter: "attention" }}
          className="flex items-center gap-3 rounded-2xl border border-approval/40 bg-approval-soft p-4 text-approval-ink"
        >
          <AlertCircle className="size-5 shrink-0" aria-hidden />
          <span className="flex-1 font-semibold">
            {attention} {attention === 1 ? "item needs" : "items need"} attention
          </span>
          <ChevronRight className="size-5" aria-hidden />
        </Link>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold">Activity</h2>
          {sorted.length > 0 && (
            <Link to="/activity" className="text-sm font-semibold text-primary">
              See all
            </Link>
          )}
        </div>
        <Card className="p-2">
          {sorted.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">No activity yet</p>
          ) : (
            sorted.slice(0, 5).map((i) => <ActivityRow key={i.id} item={i} now={now} />)
          )}
        </Card>
      </section>
    </div>
  );
}
