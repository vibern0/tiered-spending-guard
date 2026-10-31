import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { emptyState } from "@/lib/vault-store";
import { ProtectionEditor } from "./protection-editor";

const state = {
  ...emptyState(),
  policy: {
    ...emptyState().policy,
    basePerTxCap: 100000000n,
    firstSignerDaily: 250000000n,
    instantDaily: 1000000000n,
    perTxCap: 200000000n,
  },
  recipients: [{ name: "Recipient", address: "0x1111111111111111111111111111111111111111" }],
};

describe("ProtectionEditor", () => {
  it("reviews edits without changing the active onchain policy", () => {
    render(<ProtectionEditor state={state} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("First-signer daily limit (USDC)"), {
      target: { value: "300" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("heading", { name: "Review protection changes" })).toBeInTheDocument();
    expect(screen.getByText("300.00 USDC")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("not applied");
    expect(state.policy.firstSignerDaily).toBe(250000000n);
  });
  it("keeps invalid edits in the editor with a visible error", () => {
    render(<ProtectionEditor state={state} open onOpenChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("First-signer daily limit (USDC)"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("below the instant daily limit");
    expect(screen.getByLabelText("First-signer daily limit (USDC)")).toHaveValue("2000");
  });
});

it("shows exact fractional USDC amounts in the review", () => {
  render(<ProtectionEditor state={state} open onOpenChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("First-signer daily limit (USDC)"), {
    target: { value: "250.000001" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  expect(screen.getByText("250.000001 USDC")).toBeInTheDocument();
});
