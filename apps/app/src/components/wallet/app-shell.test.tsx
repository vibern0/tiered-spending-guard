import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./ui";
import { useVault } from "@/lib/vault-store";

vi.mock("@/lib/vault-store", () => ({ useVault: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => "/limits",
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  Navigate: () => null,
}));

describe("AppShell", () => {
  it("makes the account and sign-out page reachable from every main screen", () => {
    vi.mocked(useVault).mockReturnValue({
      hydrated: true,
      hasAccount: true,
      loading: false,
    } as ReturnType<typeof useVault>);
    render(
      <AppShell>
        <p>Limits</p>
      </AppShell>,
    );
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/profile");
  });
  it("preserves an open form during a background chain refresh", () => {
    const account = { hydrated: true, hasAccount: true, loading: false } as ReturnType<
      typeof useVault
    >;
    vi.mocked(useVault).mockReturnValue(account);
    const view = render(
      <AppShell>
        <input aria-label="Unsaved limit" defaultValue="250" />
      </AppShell>,
    );
    fireEvent.change(screen.getByLabelText("Unsaved limit"), { target: { value: "300" } });
    vi.mocked(useVault).mockReturnValue({ ...account, loading: true });
    view.rerender(
      <AppShell>
        <input aria-label="Unsaved limit" defaultValue="250" />
      </AppShell>,
    );
    expect(screen.getByLabelText("Unsaved limit")).toHaveValue("300");
  });
});
