import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { ActivityRow, Card, PageHeader } from "@/components/wallet/ui";
import { effectiveStatus, needsAttention } from "@/lib/activity-model";
import { useNow, useVault } from "@/lib/vault-store";
import { cn } from "@/lib/utils";
import { useState } from "react";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs attention" },
  { id: "done", label: "Completed" },
  { id: "closed", label: "Cancelled & failed" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

export const Route = createFileRoute("/activity/")({
  validateSearch: z.object({ filter: z.enum(["all", "attention", "done", "closed"]).optional() }),
  head: () => ({
    meta: [
      { title: "Activity — tiered-spending-guard" },
      {
        name: "description",
        content: "Every transfer, approval and scheduled withdrawal in one timeline.",
      },
      { property: "og:title", content: "Activity — tiered-spending-guard" },
      {
        property: "og:description",
        content: "Every transfer, approval and scheduled withdrawal in one timeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ActivityPage,
});

function ActivityPage() {
  const { filter = "all" } = Route.useSearch();
  const { state, setup, submissions, accountId, reconcileSubmission } = useVault();
  const scope = accountId ?? state.safe;
  const [recovery, setRecovery] = useState<
    Record<string, { scope: string; text: string; state: string | undefined }>
  >({});
  const now = useNow();
  const match = (f: FilterId, s: ReturnType<typeof effectiveStatus>) =>
    f === "all" ||
    (f === "attention" && needsAttention(s)) ||
    (f === "done" && s === "executed") ||
    (f === "closed" && (s === "cancelled" || s === "failed" || s === "expired"));
  const items = [...state.activity]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((i) => match(filter, effectiveStatus(i, now)));

  return (
    <div>
      <PageHeader title="Activity" />
      <div className="mb-4 grid grid-cols-2 gap-2" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <Link
            key={f.id}
            to="/activity"
            search={{ filter: f.id }}
            role="tab"
            aria-selected={filter === f.id}
            className={cn(
              "rounded-2xl px-3 py-2.5 text-center text-sm font-semibold",
              filter === f.id
                ? "bg-foreground text-background"
                : "bg-card text-muted-foreground shadow-card",
            )}
          >
            {f.label}
          </Link>
        ))}
      </div>
      <Card className="p-2">
        {items.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">Nothing here</p>
        ) : (
          items.map((i) => <ActivityRow key={i.id} item={i} now={now} />)
        )}
      </Card>
      {setup.submissionIds.length > 0 && (
        <Card className="mt-4 space-y-2">
          <h2 className="font-semibold">Durable submission recovery</h2>
          <p className="text-sm text-muted-foreground">
            Receipt status updates automatically. You can also check an interrupted broadcast
            manually.
          </p>
          {setup.submissionIds
            .slice(-5)
            .reverse()
            .map((id) => (
              <div key={id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-mono">{id}</span>
                <button
                  className="shrink-0 font-semibold text-primary"
                  onClick={async () => {
                    try {
                      await reconcileSubmission(id);
                      setRecovery((current) => {
                        const next = { ...current };
                        delete next[id];
                        return next;
                      });
                    } catch (error) {
                      setRecovery((current) => ({
                        ...current,
                        [id]: {
                          scope,
                          state: submissions?.[id]?.state,
                          text: error instanceof Error ? error.message : "Recovery failed",
                        },
                      }));
                    }
                  }}
                >
                  Reconcile
                </button>
                <span className="shrink-0 text-muted-foreground" aria-live="polite">
                  {recovery[id]?.scope === scope && recovery[id]?.state === submissions?.[id]?.state
                    ? recovery[id]?.text
                    : (submissions?.[id]?.state ?? "Checking…")}
                </span>
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}
