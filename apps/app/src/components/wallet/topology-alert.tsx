import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card } from "./ui";
import { useVault } from "@/lib/vault-store";

export function TopologyAlert() {
  const { state, loading } = useVault();
  const readOnly = state.compatibility?.mode === "read-only";
  const nearLimit =
    state.policy.instantDaily > 0n && state.spentInstant * 100n >= state.policy.instantDaily * 80n;
  const queued = state.activity.some((item) => item.status === "queued" || item.status === "ready");
  return (
    <div className="space-y-2">
      <p className="rounded-2xl bg-danger-soft p-3 text-sm font-semibold text-danger-ink">
        Sepolia prototype · no signer recovery · no independent notification delivery
      </p>
      {!loading && readOnly && (
        <div role="status" className="rounded-2xl bg-secondary p-3 text-sm text-muted-foreground">
          <p className="font-semibold">Earlier vault version · read-only</p>
          <p className="mt-1">{state.compatibility?.reason}</p>
        </div>
      )}
      {!loading && !readOnly && state.health.length === 0 && !nearLimit && !queued && (
        <p className="flex items-center gap-2 rounded-2xl bg-success-soft p-3 text-sm font-semibold text-success">
          <CheckCircle2 className="size-4" aria-hidden /> Guard, Delay, and USDC checks passed.
        </p>
      )}
      {!loading && state.health.length === 0 && nearLimit && (
        <p className="rounded-2xl bg-approval-soft p-3 text-sm font-semibold text-approval-ink">
          Instant USDC spending is near its daily limit.
        </p>
      )}
      {!loading && state.health.length === 0 && queued && (
        <p className="rounded-2xl bg-danger-soft p-3 text-sm font-semibold text-danger-ink">
          A delayed operation is waiting in the verified Delay queue.
        </p>
      )}
      {!loading && state.health.length > 0 && (
        <div role="alert">
          <Card className="border border-danger/30 bg-danger-soft p-4 text-danger-ink">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-semibold">Account verification needs attention</p>
                {state.health.map((failure) => (
                  <p key={`${failure.code}:${failure.message}`} className="text-sm">
                    {failure.message}
                  </p>
                ))}
                <p className="pt-1 text-xs">Refresh your account after resolving these checks.</p>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
