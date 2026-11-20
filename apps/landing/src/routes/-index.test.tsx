// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomePage } from "../components/desktop-page";

afterEach(cleanup);

describe("retro desktop landing motion", () => {
  it("lets visitors pause and resume decorative motion while keeping the testnet link usable", () => {
    render(<HomePage />);

    const page = screen.getByRole("main");
    const toggle = screen.getByRole("button", { name: "Pause animations" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(page.getAttribute("data-motion-paused")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Resume animations" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen
        .getAllByRole("link", { name: /Try the testnet/ })[0]
        ?.getAttribute("href"),
    ).toBe("http://localhost:5173/onboarding");

    fireEvent.click(screen.getByRole("button", { name: "Resume animations" }));
    expect(page.getAttribute("data-motion-paused")).toBe("false");
  });
});
