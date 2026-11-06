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
    const message = describeProvisioningError(
      new BackendRequestError({
        status: 400,
        message:
          "provisioning quote nonce mismatch for secondary-signer: expected 1032, observed 1033",
        code: "provisioning_nonce_mismatch",
        stage: "provisioning-quote",
        requestId: "request-123",
      }),
    );

    expect(message).toContain("secondary-signer");
    expect(message).toMatch(/automatic/i);
    expect(message).not.toMatch(/restart.*backend|check.*log/i);
    expect(message).toContain("request-123");
  });
});

it("keeps permanent setup failures explicit and carries their reference", () => {
  const message = describeProvisioningError(
    new BackendRequestError({
      status: 400,
      message: "Deployment bytecode mismatch",
      code: "deployment_verification_failed",
      requestId: "permanent-456",
    }),
  );
  expect(message).toMatch(/stopped|failed/i);
  expect(message).toContain("permanent-456");
  expect(message).not.toMatch(/automatically retry/i);
});
