import { render, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, useVaultMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  useVaultMock: vi.fn(),
}));

vi.mock("@/lib/vault-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vault-store")>()),
  useVault: useVaultMock,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => navigateMock,
}));

import { usdc } from "@/lib/usdc";
import { classify, emptyState } from "@/lib/vault-store";
import { Route as SendRoute } from "./send";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const SendPage = (SendRoute as unknown as { component: ComponentType }).component;

describe("send policy boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never offers a send lane for an unprovisioned or unhealthy vault", () => {
    const state = {
      ...emptyState(),
      balance: usdc(100),
      recipients: [{ name: "Test", address: RECIPIENT }],
    };
    expect(classify(state, RECIPIENT, usdc(1))).toMatchObject({ lane: "blocked" });
  });

  it("allows any valid recipient in the base lane but keeps elevated lanes allowlisted", () => {
    const state = {
      ...emptyState(),
      writable: true,
      health: [],
      safe: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      balance: usdc(1000),
      recipients: [{ name: "Test", address: RECIPIENT }],
    };
    expect(classify(state, RECIPIENT, usdc(1))).toMatchObject({ lane: "base" });
    expect(classify(state, RECIPIENT, usdc(2))).toMatchObject({ lane: "step-up" });
    expect(classify(state, RECIPIENT, usdc(4))).toMatchObject({ lane: "delayed" });
    expect(classify(state, "0x2222222222222222222222222222222222222222", usdc(1))).toMatchObject({ lane: "base" });
    expect(classify(state, "0x2222222222222222222222222222222222222222", usdc(2))).toMatchObject({ lane: "blocked" });
  });

  it("refreshes the verified vault snapshot once when the send flow opens", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useVaultMock.mockReturnValue({
      state: {
        ...emptyState(),
        writable: true,
        health: [],
        safe: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recipients: [{ name: "Test", address: RECIPIENT }],
      },
      loading: false,
      refresh,
      sendUsdc: vi.fn(),
    });

    render(<SendPage />);

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
