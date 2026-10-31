import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isLoopbackAddress, type BackendConfig } from "./config";
import { RegistrationSessionStore } from "./session";
import { verifyPasskeyRegistration } from "./webauthn";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { PreparedUsdcTransfer, SafeExecutionRequest } from "./vault";
import { SubmissionJournal } from "./journal";

export type VaultProvisioningResult = Readonly<{
  chainId: 11155111;
  safe: `0x${string}`;
  guard: `0x${string}`;
  delay: `0x${string}`;
  primaryPasskey: `0x${string}`;
  secondaryPasskey: `0x${string}`;
  usdc: `0x${string}`;
  evidence: Readonly<{ setupTransactionHash: `0x${string}`; verificationReportHash: `0x${string}` }>;
}>;

export type BackendHandlers = Readonly<{
  provisionVault: (body: unknown) => Promise<VaultProvisioningResult>;
  storeCredential?: (credential: Awaited<ReturnType<typeof verifyPasskeyRegistration>>) => void;
  prepareTransfer?: (body: unknown) => Promise<SafeExecutionRequest>;
  submit?: (id: string, body: unknown) => Promise<unknown>;
  submission?: (id: string) => unknown;
}>;

export type BackendServer = Readonly<{ server: Server; sessions: RegistrationSessionStore; journal: SubmissionJournal; close: () => Promise<void> }>;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (Buffer.concat(chunks).length > 256 * 1024) throw new Error("request too large");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"), (key, value) => {
      if (["amount", "nonce", "window", "baseSpent", "instantSpent"].includes(key) && typeof value === "string" && /^\d+n$/.test(value)) return BigInt(value.slice(0, -1));
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

export function createBackendServer(config: BackendConfig, handlers: BackendHandlers): BackendServer {
  const sessions = new RegistrationSessionStore(config);
  const journal = new SubmissionJournal(config.journalPath);
  const server = createServer(async (req, res) => {
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
      if (req.method === "GET" && (req.url ?? "/").split("?", 1)[0] === "/health") return json(res, 200, { ok: true, chainId: config.chainId, profileId: config.id, origin: config.origin, rpId: config.rpId });
      const segments = pathSegments(req.url ?? "/");
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
        handlers.storeCredential?.(credential);
        return json(res, 200, { role, credentialId: credential.credentialId, counter: credential.counter });
      }
      if (req.method === "POST" && segments.join("/") === "v1/vaults") return json(res, 200, await handlers.provisionVault(await body(req)));
      if (req.method === "POST" && segments.join("/") === "v1/submissions/prepare") {
        if (!handlers.prepareTransfer) throw new Error("submission preparation unavailable");
        const request = await handlers.prepareTransfer(await body(req) as PreparedUsdcTransfer);
        const id = request.idempotencyKey;
        journal.prepare(id, request.safeTxHash);
        return json(res, 200, { id, request });
      }
      if (req.method === "POST" && segments[0] === "v1" && segments[1] === "submissions" && segments[3] === "submit") {
        if (!handlers.submit || !segments[2]) throw new Error("submission unavailable");
        return json(res, 200, await handlers.submit(segments[2], await body(req)));
      }
      if (req.method === "GET" && segments[0] === "v1" && segments[1] === "submissions" && segments[2]) {
        if (!handlers.submission) throw new Error("submission unavailable");
        return json(res, 200, handlers.submission(segments[2]));
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : "backend request failed" });
    }
  });
  return Object.freeze({ server, sessions, journal, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
}
