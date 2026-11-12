import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { BackendConfig } from "./config";

export type BackendLogEvent = Readonly<{
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  stage?: string;
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  host?: string;
  port?: number;
  url?: string;
  allowedOrigin?: string;
}>;
export type BackendLogger = (event: BackendLogEvent) => void;

export const writeBackendLog: BackendLogger = (event) => {
  const output = JSON.stringify({ time: new Date().toISOString(), ...event });
  if (event.level === "error") console.error(output);
  else console.log(output);
};

// Log only closed route names. Never copy user-controlled paths or identifiers.
export function backendLogRoute(url: string | undefined): string {
  const path = (url ?? "/").split("?", 1)[0]!;
  if (
    [
      "/health",
      "/v1/auth/session",
      "/v1/auth/setup",
      "/v1/auth/logout",
      "/v1/auth/login/options",
      "/v1/auth/login/verify",
      "/v1/vaults/current",
      "/v1/vaults/auto-provision",
      "/v1/submissions/prepare",
    ].includes(path)
  )
    return path;
  const registration = /^\/v1\/registrations\/(primary|secondary)\/(options|verify)$/.exec(path);
  if (registration) return `/v1/registrations/${registration[1]}/${registration[2]}`;
  const rebind = /^\/v1\/credentials\/(primary|secondary)\/rebind\/(options|verify)$/.exec(path);
  if (rebind) return `/v1/credentials/${rebind[1]}/rebind/${rebind[2]}`;
  if (/^\/v1\/submissions\/[A-Za-z0-9._:-]{1,160}\/submit$/.test(path))
    return "/v1/submissions/:id/submit";
  if (/^\/v1\/submissions\/[A-Za-z0-9._:-]{1,160}$/.test(path)) return "/v1/submissions/:id";
  return "unmatched";
}

export function observeBackendRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestId: string,
  log: BackendLogger = writeBackendLog,
): void {
  const started = performance.now();
  const method = ["GET", "POST", "OPTIONS"].includes(req.method ?? "") ? req.method! : "OTHER";
  const context = { requestId, method, route: backendLogRoute(req.url) };
  log({
    level: "info",
    code: "request_received",
    ...context,
    message: "Request received",
  });
  let reported = false;
  const complete = (aborted: boolean) => {
    if (reported) return;
    reported = true;
    log({
      level: aborted ? "warn" : "info",
      code: aborted ? "request_aborted" : "request_completed",
      ...context,
      ...(!aborted || res.headersSent ? { status: res.statusCode } : {}),
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      message: aborted ? "Request connection closed before completion" : "Request completed",
    });
  };
  res.once("finish", () => complete(false));
  res.once("close", () => complete(!res.writableFinished));
}

export function logBackendStarting(
  config: BackendConfig,
  log: BackendLogger = writeBackendLog,
): void {
  log({
    level: "info",
    code: "backend_starting",
    stage: "startup",
    host: config.host,
    port: config.port,
    allowedOrigin: config.origin,
    message: "Starting backend; verifying saved accounts before accepting requests",
  });
}

export function logBackendReady(
  config: BackendConfig,
  server: Server,
  log: BackendLogger = writeBackendLog,
): void {
  const address = server.address();
  if (!server.listening || !address || typeof address === "string")
    throw new Error("backend is not listening");
  const url = `http://localhost:${address.port}`;
  log({
    level: "info",
    code: "backend_ready",
    stage: "startup",
    host: address.address,
    port: address.port,
    url,
    allowedOrigin: config.origin,
    message: `Backend ready at ${url}`,
  });
}
