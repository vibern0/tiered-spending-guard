import { Link, Navigate, useRouterState } from "@tanstack/react-router";
import { Activity, ChevronRight, Home, Shield, UserRound } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  STATUS_META,
  effectiveStatus,
  type ActivityItem,
  type ActivityStatus,
} from "@/lib/activity-model";
import { formatUsdc } from "@/lib/usdc";
import { useVault } from "@/lib/vault-store";
import { useWalletOnline } from "@/lib/pwa";
import { PwaStatus } from "./pwa-status";

const TONE: Record<string, string> = {
  approval: "bg-approval-soft text-approval-ink",
  danger: "bg-danger-soft text-danger-ink",
  success: "bg-success-soft text-success",
  primary: "bg-primary-soft text-primary",
  neutral: "bg-secondary text-muted-foreground",
};

export function StatusBadge({ status }: { status: ActivityStatus }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
        TONE[m.tone],
      )}
    >
      <Icon className={cn("size-3.5", status === "submitting" && "animate-spin")} aria-hidden />
      {m.label}
    </span>
  );
}

export function NetworkPill() {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full border border-approval/40 bg-approval-soft px-2.5 py-0.5 text-xs font-semibold text-approval-ink">
      Sepolia testnet
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-3xl bg-card p-5 shadow-card", className)}>{children}</div>;
}

export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="flex items-center justify-between pb-4 pt-6">
      <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
      {right}
    </header>
  );
}

export function PrimaryButton({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const online = useWalletOnline();
  return (
    <button
      {...p}
      disabled={p.disabled || !online}
      className={cn(
        "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3.5 text-base font-semibold text-primary-foreground transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 disabled:opacity-50",
        className,
      )}
    />
  );
}

export function SecondaryButton({
  className,
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const online = useWalletOnline();
  return (
    <button
      {...p}
      disabled={p.disabled || !online}
      className={cn(
        "inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-primary-soft px-5 py-3.5 text-base font-semibold text-primary transition hover:bg-primary-soft/70 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/40 disabled:opacity-50",
        className,
      )}
    />
  );
}

export function ActivityRow({ item, now }: { item: ActivityItem; now: number }) {
  const status = effectiveStatus(item, now);
  return (
    <Link
      to="/activity/$id"
      params={{ id: item.id }}
      className="flex items-center gap-3 rounded-2xl px-2 py-3 transition hover:bg-secondary/60"
    >
      <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary-soft font-semibold text-primary">
        {item.counterparty.slice(0, 1)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate font-semibold">{item.counterparty}</span>
          <span
            className={cn(
              "shrink-0 font-semibold tabular-nums",
              item.direction === "in" && "text-success",
            )}
          >
            {item.kind === "recipient-addition"
              ? "Policy change"
              : item.kind === "cancel"
                ? "Queue cancellation"
                : item.kind === "execute"
                  ? "Queue execution"
                  : item.kind === "skip"
                    ? "Expired item skipped"
                    : item.proposal
                      ? `Scheduled · ${formatUsdc(item.amount)}`
                      : item.direction === "self"
                        ? `Self · ${formatUsdc(item.amount)}`
                        : item.kind === "unsupported"
                          ? "Review required"
                          : `${item.direction === "in" ? "+" : "−"}${formatUsdc(item.amount)}`}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <StatusBadge status={status} />
          <time className="text-xs text-muted-foreground">{relTime(item.createdAt, now)}</time>
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  );
}

export function relTime(t: number, now: number) {
  if (t <= 0) return "Time unavailable";
  const d = now - t;
  if (d < 60_000) return "Just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(t).toLocaleDateString("en-IE", { day: "numeric", month: "short" });
}

export function Details({
  summary = "Technical details",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-2xl bg-secondary/60 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-muted-foreground">
        {summary}
      </summary>
      <dl className="mt-3 space-y-2 text-sm">{children}</dl>
    </details>
  );
}

export function DRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="break-all text-right font-mono text-xs">{v}</dd>
    </div>
  );
}

const TABS = [
  { to: "/", label: "Home", icon: Home },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/limits", label: "Limits", icon: Shield },
  { to: "/profile", label: "Account", icon: UserRound },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { hydrated, loading, hasAccount } = useVault();
  const [initialReadFinished, setInitialReadFinished] = useState(false);
  useEffect(() => {
    if (hydrated && !loading) setInitialReadFinished(true);
  }, [hydrated, loading]);
  const hideNav = path.startsWith("/onboarding");
  if (hydrated && !hasAccount && !hideNav) return <Navigate to="/onboarding" replace />;
  const ready = hydrated && (!hasAccount || initialReadFinished);
  return (
    <div className="mx-auto min-h-screen w-full min-w-0 max-w-md px-5 pb-[calc(7rem+env(safe-area-inset-bottom))]">
      <PwaStatus />
      {ready && hasAccount && !hideNav && path !== "/" && (
        <p className="mt-4 rounded-2xl bg-danger-soft p-3 text-sm font-semibold text-danger-ink">
          Sepolia prototype · no signer recovery · no independent notification delivery
        </p>
      )}
      {ready ? (
        children
      ) : (
        <div className="pt-24 text-center text-muted-foreground">Loading your account…</div>
      )}
      {ready && hasAccount && !hideNav && (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        >
          <ul className="mx-auto grid max-w-md grid-cols-4">
            {TABS.map(({ to, label, icon: Icon }) => {
              const active = to === "/" ? path === "/" : path.startsWith(to);
              return (
                <li key={to}>
                  <Link
                    to={to}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 flex-col items-center gap-1 py-3 text-xs font-semibold",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
