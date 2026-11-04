export class BackendRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly stage: string | undefined;
  readonly requestId: string | undefined;

  constructor(input: Readonly<{ status: number; message: string; code?: string; stage?: string; requestId?: string }>) {
    super(input.message);
    this.name = "BackendRequestError";
    this.status = input.status;
    this.code = input.code;
    this.stage = input.stage;
    this.requestId = input.requestId;
  }
}

export function describeProvisioningError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown provisioning error";

  if (error instanceof BackendRequestError && error.code === "provisioning_nonce_mismatch") {
    const transaction = message.match(/(?:for|before) ([a-z][a-z0-9-]+)/i)?.[1] ?? "the next deployment step";
    const reference = error.requestId ? ` Reference: ${error.requestId}.` : "";
    return `The relay nonce changed before ${transaction}. Restart the backend so it can verify the committed recovery path, then retry automatic provisioning.${reference}`;
  }

  if (error instanceof BackendRequestError && error.code === "rpc_request_failed") {
    const reference = error.requestId ? ` Reference: ${error.requestId}.` : "";
    return `A Sepolia provider failed during ${error.stage ?? "provisioning"}. Check the backend log with the matching reference, then retry.${reference}`;
  }

  if (message.includes("VITE_SEPOLIA_RPC_URL")) {
    return "Set VITE_SEPOLIA_RPC_URL to a Sepolia RPC URL and restart the app before creating a passkey vault.";
  }

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "The local backend is not reachable at http://127.0.0.1:8787. Start the backend, then retry.";
  }

  if (/backend health check failed/i.test(message)) {
    return `The local backend is unhealthy. Fix its readiness error, then retry: ${message.replace(/^Backend health check failed:\s*/i, "")}`;
  }

  if (/notallowederror|cancelled|canceled/i.test(message)) {
    return "Passkey creation was cancelled. Allow the browser passkey prompt and retry.";
  }

  return `Vault setup failed: ${message}`;
}
