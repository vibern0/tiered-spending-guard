import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PwaStatus } from "./pwa-status";
import { PrimaryButton } from "./ui";

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
  window.dispatchEvent(new Event(value ? "online" : "offline"));
}

afterEach(() => {
  setOnline(true);
  vi.restoreAllMocks();
});

describe("PwaStatus", () => {
  it("shows an offline read-only warning and disables wallet write controls", () => {
    setOnline(false);
    render(
      <>
        <PwaStatus />
        <PrimaryButton>Send USDC</PrimaryButton>
      </>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Offline read-only mode");
    expect(screen.getByRole("button", { name: "Send USDC" })).toBeDisabled();
    expect(screen.queryByText(/success/i)).not.toBeInTheDocument();
  });

  it("offers the captured browser install prompt and clears it after acceptance", async () => {
    render(<PwaStatus />);
    const prompt = vi.fn(async () => undefined);
    const userChoice = Promise.resolve({ outcome: "accepted" as const, platform: "web" });
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt,
      userChoice,
    });
    act(() => {
      window.dispatchEvent(event);
    });

    fireEvent.click(await screen.findByRole("button", { name: "Install wallet" }));
    expect(prompt).toHaveBeenCalledOnce();
    expect(await userChoice).toMatchObject({ outcome: "accepted" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Install wallet" })).not.toBeInTheDocument(),
    );
  });

  it("reports an available update without forcing activation", () => {
    render(<PwaStatus />);
    act(() => {
      window.dispatchEvent(new CustomEvent("wallet-pwa-update-ready"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Update ready");
    expect(screen.getByRole("button", { name: "Reload to update" })).toBeInTheDocument();
  });
});
