export class BackendRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly stage: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    input: Readonly<{
      status: number;
      message: string;
      code?: string;
      stage?: string;
      requestId?: string;
    }>,
  ) {
    super(input.message);
    this.name = "BackendRequestError";
    this.status = input.status;
    this.code = input.code;
    this.stage = input.stage;
    this.requestId = input.requestId;
  }
}

export function canRetryAutomaticProvisioning(error: unknown): boolean {
  return (
    error instanceof BackendRequestError &&
    [
      "rpc_request_failed",
      "provisioning_nonce_mismatch",
      "provisioning_pending_confirmation",
    ].includes(error.code ?? "")
  );
}

export function describeProvisioningError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provisioning error";
  const reference =
    error instanceof BackendRequestError && error.requestId
      ? ` Reference: ${error.requestId}.`
      : "";

  if (error instanceof BackendRequestError && error.code === "provisioning_nonce_mismatch") {
    const transaction =
      message.match(/(?:for|before) ([a-z][a-z0-9-]+)/i)?.[1] ?? "the next deployment step";
    return `Setup is waiting for verified recovery before ${transaction}. Recovery is automatic; your existing signers are preserved. If the wait continues, use Retry automatic provisioning.${reference}`;
  }

  if (error instanceof BackendRequestError && error.code === "rpc_request_failed") {
    return `A Sepolia provider is temporarily unavailable. Setup is recovering automatically. If the wait continues, use Retry automatic provisioning.${reference}`;
  }

  if (error instanceof BackendRequestError && error.code === "provisioning_pending_confirmation") {
    return `Setup is waiting for the recorded transaction to confirm. Confirmation checks resume automatically. If the wait continues, use Retry automatic provisioning.${reference}`;
  }

  if (message.includes("VITE_SEPOLIA_RPC_URL")) {
    return "Set VITE_SEPOLIA_RPC_URL to a Sepolia RPC URL and restart the app before creating a passkey vault.";
  }

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The local backend is not reachable at http://localhost:8787. Start the backend, then retry.";
  }

  if (/backend health check failed/i.test(message)) {
    return `The local backend is unhealthy. Setup has stopped safely; your existing signers are preserved. Reference: ${message.replace(/^Backend health check failed:\s*/i, "")}`;
  }

  if (/notallowederror|cancelled|canceled/i.test(message)) {
    return "Passkey creation was cancelled. Allow the browser passkey prompt and retry.";
  }

  return `Vault setup stopped safely: ${message}${reference}`;
}
