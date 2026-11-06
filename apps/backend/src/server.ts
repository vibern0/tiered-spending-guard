import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isLoopbackAddress, type BackendConfig } from "./config";
import { RebindSessionStore, RegistrationSessionStore } from "./session";
import { verifyPasskeyRebind, verifyPasskeyRegistration, type BackendPasskeyRole, type StoredCredential } from "./webauthn";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { BackendPreparedSubmission } from "./vault";
import { SubmissionJournal } from "./journal";
import type { PwaHistoricalVault } from "@recent-tx-safe-guard/security-core/pwa";

export type VaultProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: `0x${string}`;
  guard: `0x${string}`;
  delay: `0x${string}`;
  primaryPasskey: `0x${string}`;
  secondaryPasskey: `0x${string}`;
  usdc: `0x${string}`;
  evidence: Readonly<{ setupTransactionHash: `0x${string}`; verificationReportHash: `0x${string}`; deploymentsHash: `0x${string}`; policyHash: `0x${string}` }>;
  credentialRebind: Readonly<{ required: boolean; primary: "required" | "ready"; secondary: "required" | "ready" }>;
}>;

export type BackendHandlers = Readonly<{
  historicalVault?: PwaHistoricalVault;
  getReadiness?: () => Readonly<{ provisioningReady: boolean; writesReady: boolean }>;
  writesReady?: boolean;
  currentVault?: () => PwaHistoricalVault | VaultProvisioningResult | undefined;
  autoProvisionVault: (body: unknown) => Promise<VaultProvisioningResult>;
  storeCredential?: (credential: Awaited<ReturnType<typeof verifyPasskeyRegistration>>) => void;
  prepareTransfer?: (body: unknown) => Promise<BackendPreparedSubmission>;
  submit?: (id: string, body: unknown) => Promise<unknown>;
  submission?: (id: string) => Promise<unknown>;
  rebindCoordinates?: (role: BackendPasskeyRole) => Readonly<{ x: bigint; y: bigint }>;
  storeReboundCredential?: (credential: StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>) => unknown;
  verifyRebind?: typeof verifyPasskeyRebind;
}>;

export type BackendServer = Readonly<{ server: Server; sessions: RegistrationSessionStore; rebindSessions: RebindSessionStore; journal: SubmissionJournal; close: () => Promise<void> }>;

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

export type BackendServerOptions = Readonly<{
  log?: (event: BackendDiagnosticEvent) => void;
}>;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 256 * 1024) throw new Error("request too large");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"), (key, value) => {
      if (["amount", "nonce", "queueNonce", "window", "baseSpent", "instantSpent"].includes(key) && typeof value === "string" && /^\d+n$/.test(value)) return BigInt(value.slice(0, -1));
      return value;
    });
  } catch { throw new Error("request body must be JSON"); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const output = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(output);
}

function pathSegments(value: string): string[] {
  return value.split("/").filter(Boolean);
}

export function sanitizeBackendMessage(error: unknown): string {
  if (!(error instanceof Error)) return "backend request failed";
  return error.message
    .replace(/https?:\/\/[^\s]+/gi, "[redacted]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted]");
}

function diagnosticFor(message: string): Readonly<{ code: string; stage: string }> {
  if (message === "automatic provisioning is still awaiting canonical confirmations for its recorded transaction") return { code: "provisioning_pending_confirmation", stage: "provisioning-reconciliation" };
  if (/provisioning quote nonce mismatch|provisioning relay nonce mismatch/i.test(message)) return { code: "provisioning_nonce_mismatch", stage: "provisioning-quote" };
  if (/deployer nonce does not equal|nonce drift before provisioning transaction|relay latest\/pending nonce changed/i.test(message)) return { code: "provisioning_nonce_mismatch", stage: "provisioning-execution" };
  if (/automatic provisioning recovery/i.test(message)) return { code: "provisioning_recovery_failed", stage: "provisioning-recovery" };
  if (/Sepolia RPC request failed/i.test(message)) return { code: "rpc_request_failed", stage: "provisioning-rpc" };
  return { code: "request_failed", stage: "request" };
}

export function createBackendServer(config: BackendConfig, handlers: BackendHandlers, options: BackendServerOptions = {}): BackendServer {
  const sessions = new RegistrationSessionStore(config);
  const rebindSessions = new RebindSessionStore(config);
  const journal = new SubmissionJournal(config.journalPath);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const route = (req.url ?? "/").split("?", 1)[0] ?? "/";
    res.setHeader("x-request-id", requestId);
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) return json(res, 403, { error: "loopback only" });
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.origin) return json(res, 403, { error: "origin not allowed" });
      if (origin !== undefined) {
        res.setHeader("access-control-allow-origin", config.origin);
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type");
        if (config.id === "https") res.setHeader("access-control-allow-credentials", "true");
        res.setHeader("vary", "Origin");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      if (req.method === "GET" && (req.url ?? "/").split("?", 1)[0] === "/health") {
        const readiness = handlers.getReadiness?.();
        const provisioningReady = !handlers.historicalVault && (readiness?.provisioningReady ?? false);
        const writesReady = !handlers.historicalVault && (readiness?.writesReady ?? handlers.writesReady ?? Boolean(handlers.prepareTransfer && handlers.submit && handlers.submission));
        return json(res, 200, { ok: true, provisioningReady, writesReady, chainId: config.chainId, profileId: config.id, origin: config.origin, rpId: config.rpId,
          ...(handlers.historicalVault ? { vaultCompatibility: { mode: "read-only", profileVersion: handlers.historicalVault.profileVersion, reason: "This vault uses an earlier recipient policy. Transfers are disabled." } } : {}),
        });
      }
      const segments = pathSegments(req.url ?? "/");
      if (req.method === "GET" && segments.join("/") === "v1/vaults/current") {
        const current = handlers.currentVault?.();
        return current ? json(res, 200, current) : json(res, 404, { error: "vault is not provisioned" });
      }
      if (req.method === "POST" && handlers.historicalVault) return json(res, 409, { code: "vault_read_only", error: "This vault uses an earlier recipient policy and is available for viewing. Transfers and credential changes are disabled." });
      if (req.method === "POST" && segments[0] === "v1" && segments[1] === "registrations" && segments[3] === "options") {
        const role = segments[2] as "primary" | "secondary";
        const session = sessions.create(role);
        return json(res, 200, { sessionId: session.id, challenge: session.challenge, rpId: session.rpId, origin: session.origin, role: session.role, userVerification: "required", authenticatorAttachment: session.authenticatorAttachment });
      }
      if (req.method === "POST" && segments[0] === "v1" && segments[1] === "registrations" && segments[3] === "verify") {
        const role = segments[2] as "primary" | "secondary";
        const input = await body(req) as { sessionId?: string; registration?: RegistrationResponseJSON };
        if (!input.sessionId || !input.registration) throw new Error("registration session and response are required");
        const session = sessions.consume(input.sessionId, role);
        const credential = await verifyPasskeyRegistration({ role, credentialId: input.registration.id, challenge: session.challenge, rpId: session.rpId, origin: session.origin, response: input.registration });
        if (!handlers.storeCredential) throw new Error("credential storage unavailable");
        handlers.storeCredential(credential);
        sessions.markRegistered(role);
        return json(res, 200, { role, credentialId: credential.credentialId, counter: credential.counter });
      }
      if (req.method === "POST" && segments[0] === "v1" && segments[1] === "credentials" && segments[3] === "rebind" && segments[4] === "options") {
        if (config.id !== "local") return json(res, 404, { error: "not found" });
        const role = segments[2] as BackendPasskeyRole;
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) throw new Error("credential rebind options body must be empty");
        if (!handlers.rebindCoordinates) throw new Error("credential rebind unavailable");
        handlers.rebindCoordinates(role);
        const session = rebindSessions.create(role);
        return json(res, 200, { sessionId: session.id, challenge: session.challenge, rpId: session.rpId, origin: session.origin, role: session.role, userVerification: "required" });
      }
      if (req.method === "POST" && segments[0] === "v1" && segments[1] === "credentials" && segments[3] === "rebind" && segments[4] === "verify") {
        if (config.id !== "local") return json(res, 404, { error: "not found" });
        const role = segments[2] as BackendPasskeyRole;
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("credential rebind verification body must be an object");
        const value = input as Record<string, unknown>;
        if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "sessionId") || !Object.hasOwn(value, "assertion") || typeof value.sessionId !== "string" || !value.assertion) throw new Error("credential rebind session and assertion are required");
        if (!handlers.rebindCoordinates || !handlers.storeReboundCredential) throw new Error("credential rebind unavailable");
        const coordinates = handlers.rebindCoordinates(role);
        const session = rebindSessions.consume(value.sessionId, role);
        const credential = await (handlers.verifyRebind ?? verifyPasskeyRebind)({ role, coordinates, challenge: session.challenge, rpId: session.rpId, origin: session.origin, response: value.assertion as AuthenticationResponseJSON });
        const status = handlers.storeReboundCredential(credential);
        return json(res, 200, { role, credentialId: credential.credentialId, counter: credential.counter, credentialRebind: status });
      }
      if (req.method === "POST" && segments.join("/") === "v1/vaults/auto-provision") {
        if (config.id !== "local") return json(res, 404, { error: "not found" });
        return json(res, 200, await handlers.autoProvisionVault(await body(req)));
      }
      if (req.method === "POST" && segments.join("/") === "v1/submissions/prepare") {
        if (!handlers.prepareTransfer) return json(res, 503, { error: "submission runtime is not ready" });
        const request = await handlers.prepareTransfer(await body(req));
        return json(res, 200, request);
      }
      if (req.method === "POST" && segments[0] === "v1" && segments[1] === "submissions" && segments[3] === "submit") {
        if (!handlers.submit || !segments[2]) throw new Error("submission unavailable");
        return json(res, 200, await handlers.submit(segments[2], await body(req)));
      }
      if (req.method === "GET" && segments[0] === "v1" && segments[1] === "submissions" && segments[2]) {
        if (!handlers.submission) throw new Error("submission unavailable");
        return json(res, 200, await handlers.submission(segments[2]));
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      const message = sanitizeBackendMessage(error);
      const diagnostic = diagnosticFor(message);
      const event = Object.freeze({ level: "error", requestId, method: req.method ?? "UNKNOWN", route, status: 400, ...diagnostic, message }) satisfies BackendDiagnosticEvent;
      (options.log ?? ((value: BackendDiagnosticEvent) => console.error(JSON.stringify(value))))(event);
      return json(res, 400, { error: message, ...diagnostic, requestId });
    }
  });
  return Object.freeze({ server, sessions, rebindSessions, journal, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
}
