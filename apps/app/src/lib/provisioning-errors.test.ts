import { describe, expect, it } from "vitest";
import { BackendRequestError, describeProvisioningError } from "./provisioning-errors";

describe("describeProvisioningError", () => {
  it("turns the missing RPC failure into an actionable setup message", () => {
    expect(
      describeProvisioningError(
        new Error("Set VITE_SEPOLIA_RPC_URL before provisioning the demo vault"),
      ),
    ).toContain("VITE_SEPOLIA_RPC_URL");
  });

  it("turns an unreachable backend failure into an actionable setup message", () => {
    expect(describeProvisioningError(new TypeError("Failed to fetch"))).toContain("local backend");
  });

  it("distinguishes an unhealthy backend from a cancelled passkey", () => {
    expect(
      describeProvisioningError(new Error("Backend health check failed: RPC unavailable")),
    ).toContain("backend is unhealthy");
  });

  it("turns a correlated nonce failure into an actionable retry message", () => {
    const message = describeProvisioningError(new BackendRequestError({
      status: 400,
      message: "provisioning quote nonce mismatch for secondary-signer: expected 1032, observed 1033",
      code: "provisioning_nonce_mismatch",
      stage: "provisioning-quote",
      requestId: "request-123",
    }));

    expect(message).toContain("secondary-signer");
    expect(message).toMatch(/restart the backend/i);
    expect(message).toContain("request-123");
  });
});
