import type { Server } from "node:http";
import type { FastifyInstance } from "fastify";
import type { PwaHistoricalVault } from "@tiered-spending-guard/security-core/pwa";
import { createBackendFastify } from "./http/fastify";
import { backendLogRoute, writeBackendLog, type BackendLogger } from "./logging";
import type { BackendConfig } from "./config";
import { RebindSessionStore, RegistrationSessionStore } from "./session";
import { verifyPasskeyRebind, type BackendPasskeyRole, type StoredCredential } from "./webauthn";
import type { BackendPreparedSubmission } from "./vault";
import { SubmissionJournal } from "./journal";
import { registerLegacyRoutes } from "./routes/legacy";

export type VaultProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: `0x${string}`;
  guard: `0x${string}`;
  delay: `0x${string}`;
  primaryPasskey: `0x${string}`;
  secondaryPasskey: `0x${string}`;
  usdc: `0x${string}`;
  evidence: Readonly<{
    setupTransactionHash: `0x${string}`;
    verificationReportHash: `0x${string}`;
    deploymentsHash: `0x${string}`;
    policyHash: `0x${string}`;
    blockNumber: string;
  }>;
  credentialRebind: Readonly<{
    required: boolean;
    primary: "required" | "ready";
    secondary: "required" | "ready";
  }>;
}>;

export type BackendHandlers = Readonly<{
  historicalVault?: PwaHistoricalVault;
  getReadiness?: () => Readonly<{ provisioningReady: boolean; writesReady: boolean }>;
  writesReady?: boolean;
  currentVault?: () => PwaHistoricalVault | VaultProvisioningResult | undefined;
  autoProvisionVault: (body: unknown) => Promise<VaultProvisioningResult>;
  storeCredential?: (
    credential: Awaited<ReturnType<typeof import("./webauthn").verifyPasskeyRegistration>>,
  ) => void;
  prepareTransfer?: (body: unknown) => Promise<BackendPreparedSubmission>;
  submit?: (id: string, body: unknown) => Promise<unknown>;
  submission?: (id: string) => Promise<unknown>;
  rebindCoordinates?: (role: BackendPasskeyRole) => Readonly<{ x: bigint; y: bigint }>;
  storeReboundCredential?: (
    credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>,
  ) => unknown;
  verifyRebind?: typeof verifyPasskeyRebind;
}>;

export type BackendServer = Readonly<{
  fastify: FastifyInstance;
  server: Server;
  sessions: RegistrationSessionStore;
  rebindSessions: RebindSessionStore;
  journal: SubmissionJournal;
  close: () => Promise<void>;
}>;

export type BackendDiagnosticEvent = Readonly<{
  level: "error";
  requestId: string;
  method: string;
  route: string;
  status: number;
  code: string;
  stage: string;
  message: string;
}>;

export type BackendServerOptions = Readonly<{ log?: BackendLogger }>;

export function sanitizeBackendMessage(error: unknown): string {
  if (!(error instanceof Error)) return "backend request failed";
  return error.message
    .replace(/https?:\/\/[^\s]+/gi, "[redacted]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted]");
}
function diagnosticFor(message: string): Readonly<{ code: string; stage: string }> {
  if (
    message ===
    "automatic provisioning is still awaiting canonical confirmations for its recorded transaction"
  )
    return { code: "provisioning_pending_confirmation", stage: "provisioning-reconciliation" };
  if (/provisioning quote nonce mismatch|provisioning relay nonce mismatch/i.test(message))
    return { code: "provisioning_nonce_mismatch", stage: "provisioning-quote" };
  if (
    /deployer nonce does not equal|nonce drift before provisioning transaction|relay latest\/pending nonce changed/i.test(
      message,
    )
  )
    return { code: "provisioning_nonce_mismatch", stage: "provisioning-execution" };
  if (/automatic provisioning recovery/i.test(message))
    return { code: "provisioning_recovery_failed", stage: "provisioning-recovery" };
  if (/Sepolia RPC request failed/i.test(message))
    return { code: "rpc_request_failed", stage: "provisioning-rpc" };
  return { code: "request_failed", stage: "request" };
}

export function createBackendServer(
  config: BackendConfig,
  handlers: BackendHandlers,
  options: BackendServerOptions = {},
): BackendServer {
  const sessions = new RegistrationSessionStore(config);
  const rebindSessions = new RebindSessionStore(config);
  const journal = new SubmissionJournal(config.journalPath);
  const fastify = createBackendFastify({
    log: options.log,
    json: {
      strictContentType: false,
      requireObject: false,
      invalidMessage: "request body must be JSON",
      bigintKeys: ["amount", "nonce", "queueNonce", "window", "baseSpent", "instantSpent"],
    },
  });
  registerLegacyRoutes(fastify, config, handlers, sessions, rebindSessions);
  fastify.setErrorHandler((error, request, reply) => {
    if ((error as { statusCode?: number }).statusCode === 404)
      return reply.code(404).send({ error: "not found" });
    const message = sanitizeBackendMessage(error);
    const diagnostic = diagnosticFor(message);
    const event = Object.freeze({
      level: "error",
      requestId: request.id,
      method: request.method,
      route: backendLogRoute(request.raw.url),
      status: 400,
      ...diagnostic,
      message,
    }) satisfies BackendDiagnosticEvent;
    (options.log ?? writeBackendLog)(event);
    return reply.code(400).send({ error: message, ...diagnostic, requestId: request.id });
  });
  void Promise.resolve(fastify.ready()).catch((error: Error) =>
    fastify.server.emit("error", error),
  );
  return Object.freeze({
    fastify,
    server: fastify.server,
    sessions,
    rebindSessions,
    journal,
    close: () => fastify.close(),
  });
}
