import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { observeBackendRequest, writeBackendLog, type BackendLogger } from "./logging";
import { isLoopbackAddress, type BackendConfig } from "./config";
import { type AccountStore, type AccountSession } from "./account-store";
import {
  verifyPasskeyLogin,
  verifyPasskeyRebind,
  verifyPasskeyRegistration,
  type BackendPasskeyRole,
} from "./webauthn";
import type { BackendHandlerSet } from "./handlers";
import type { VaultProvisioningResult } from "./server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

export type AccountGateway = Readonly<{
  handlers(accountId: string): Promise<BackendHandlerSet>;
  provision(accountId: string): Promise<VaultProvisioningResult>;
  prepare(
    accountId: string,
    sessionId: string,
    body: unknown,
  ): Promise<unknown>;
  submit(
    accountId: string,
    sessionId: string,
    id: string,
    body: unknown,
  ): Promise<unknown>;
  status(accountId: string, id: string): Promise<unknown>;
  legacyCoordinates?(
    accountId: string,
  ): Promise<Readonly<{ x: bigint; y: bigint }> | undefined>;
  submissionIds?(accountId: string): Promise<readonly string[]>;
  releaseSession?(sessionId: string): void;
}>;
const COOKIE = "vault_local_session";
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(
    JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? `${v}n` : v)),
  );
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";", 1)[0] !== "application/json")
    throw new HttpError(415, "JSON request required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > 256 * 1024) throw new HttpError(413, "request too large");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"), (k, v) =>
      ["amount", "queueNonce", "nonce"].includes(k) &&
      typeof v === "string" &&
      /^\d+n$/.test(v)
        ? BigInt(v.slice(0, -1))
        : v,
    );
  } catch {
    throw new HttpError(400, "invalid JSON request");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "request must be an object");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join() !== [...keys].sort().join())
    throw new HttpError(400, "unsupported request fields");
}
function role(value: string): BackendPasskeyRole {
  if (value !== "primary" && value !== "secondary")
    throw new HttpError(404, "not found");
  return value;
}
function cookie(req: IncomingMessage): string {
  const values = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${COOKIE}=`));
  return values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : "";
}
function setCookie(res: ServerResponse, token: string) {
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
  );
}

/** Only localhost multi-user HTTP. Public identifiers never authenticate a request. */
export function createAccountServer(
  config: BackendConfig,
  store: AccountStore,
  gateway: AccountGateway,
  options: Readonly<{ log?: BackendLogger }> = {},
) {
  if (config.id !== "local")
    throw new Error("multi-user provisioning is localhost-only");
  const projection = async (session: AccountSession | undefined) => {
    if (!session) return { authenticated: false };
    const account = session.accountId
      ? store.account(session.accountId)
      : undefined;
    const credentials = account ? store.credentials(account.id) : [];
    // An authenticated account's current projection is verified by its runtime,
    // never taken from a saved database readiness flag.
    const vault =
      session.authenticated && account?.state === "verified"
        ? (await gateway.handlers(account.id)).currentVault?.()
        : undefined;
    return {
      authenticated: session.authenticated,
      csrfToken: session.csrfToken,
      ...(account
        ? {
            account: {
              id: account.id,
              userHandle: account.userHandle,
              state: account.state,
              primaryCredentialId: credentials.find((c) => c.role === "primary")
                ?.id,
              secondaryCredentialId: credentials.find(
                (c) => c.role === "secondary",
              )?.id,
              ...(session.authenticated && account.state === "verified"
                ? {
                    submissionIds:
                      (await gateway.submissionIds?.(account.id)) ?? [],
                  }
                : {}),
              ...(vault ? { vault } : {}),
            },
          }
        : {}),
    };
  };
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    observeBackendRequest(req, res, requestId, options.log);
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress))
        throw new HttpError(403, "loopback only");
      const bound =
        (server.address() as { port: number } | null)?.port ?? config.port;
      if (
        ![`localhost:${bound}`, `127.0.0.1:${bound}`].includes(
          req.headers.host ?? "",
        )
      )
        throw new HttpError(403, "host not allowed");
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== config.origin)
        throw new HttpError(403, "origin not allowed");
      if (origin !== undefined) {
        res.setHeader("access-control-allow-origin", config.origin);
        res.setHeader("access-control-allow-credentials", "true");
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader(
          "access-control-allow-headers",
          "content-type,x-csrf-token,x-vault-account",
        );
        res.setHeader("vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const path = (req.url ?? "/").split("?", 1)[0]!;
      if (req.url !== path) throw new HttpError(404, "not found");
      let token = cookie(req),
        session = store.session(token);
      const requireSession = (authenticated = false) => {
        if (!session || (authenticated && !session.authenticated))
          throw new HttpError(401, "sign in with your first passkey");
        return session;
      };
      const account = () => {
        const s = requireSession();
        if (!s.accountId || req.headers["x-vault-account"] !== s.accountId)
          throw new HttpError(403, "account does not match session");
        return store.account(s.accountId)!;
      };
      if (req.method === "GET" && path === "/health") {
        const h =
          session?.authenticated && session.accountId
            ? await gateway.handlers(session.accountId)
            : undefined;
        return json(res, 200, {
          ok: true,
          chainId: config.chainId,
          profileId: config.id,
          origin: config.origin,
          rpId: config.rpId,
          provisioningReady: true,
          writesReady: h?.getReadiness?.().writesReady ?? false,
        });
      }
      if (req.method === "GET" && path === "/v1/auth/session")
        return json(res, 200, await projection(session));
      if (req.method === "POST") {
        if (origin !== config.origin)
          throw new HttpError(403, "exact browser origin required");
        // Bootstrap can create only an unprivileged context, never act as a user.
        if (!["/v1/auth/setup", "/v1/auth/login/options"].includes(path)) {
          requireSession();
          try {
            store.assertCsrf(session!, req.headers["x-csrf-token"]);
          } catch {
            throw new HttpError(403, "invalid session CSRF token");
          }
        }
        const input = await body(req);
        if (path === "/v1/auth/setup") {
          exact(input, []);
          if (session?.authenticated)
            throw new HttpError(
              409,
              "sign out before creating another account",
            );
          if (session?.accountId)
            return json(res, 200, await projection(session));
          const a = store.createAccount();
          const created = store.createSession(a.id);
          setCookie(res, created.token);
          return json(res, 200, await projection(created));
        }
        if (path === "/v1/auth/login/options") {
          if (
            Object.keys(input).some((k) => k !== "accountId") ||
            (input.accountId !== undefined &&
              typeof input.accountId !== "string")
          )
            throw new HttpError(400, "unsupported login fields");
          if (!session) {
            const created = store.createSession();
            token = created.token;
            session = created;
            setCookie(res, token);
          }
          const ch = store.createChallenge(
            session.id,
            input.accountId ? `login:${input.accountId}` : "login",
          );
          const target = input.accountId
            ? store.account(input.accountId as string)
            : undefined;
          return json(res, 200, {
            sessionId: ch.id,
            challenge: ch.challenge,
            rpId: config.rpId,
            origin: config.origin,
            userVerification: "required",
            csrfToken: session.csrfToken,
            ...(target
              ? {
                  accountId: target.id,
                  credentialIds: store
                    .credentials(target.id)
                    .filter((c) => c.role === "primary")
                    .map((c) => c.id),
                }
              : {}),
          });
        }
        if (path === "/v1/auth/login/verify") {
          if (
            Object.keys(input).some(
              (k) => !["sessionId", "assertion", "accountId"].includes(k),
            ) ||
            typeof input.sessionId !== "string" ||
            !input.assertion
          )
            throw new HttpError(400, "login session and assertion required");
          const ch = store.consumeChallenge(
            session!.id,
            input.sessionId,
            input.accountId ? `login:${input.accountId}` : "login",
          );
          const assertion = input.assertion as AuthenticationResponseJSON;
          let credential = store.credential(assertion.id);
          if (!credential && gateway.legacyCoordinates) {
            const target = store.account(
              typeof input.accountId === "string" ? input.accountId : "legacy",
            );
            if (!target?.legacy)
              throw new HttpError(400, "first passkey authentication failed");
            const coordinates = await gateway.legacyCoordinates(target.id);
            if (!coordinates)
              throw new HttpError(400, "existing account proof unavailable");
            const verified = await verifyPasskeyRebind({
              role: "primary",
              coordinates,
              challenge: ch.challenge,
              rpId: config.rpId,
              origin: config.origin,
              response: assertion,
            });
            store.storeCredential(target.id, verified);
            credential = store.credential(verified.id);
          } else {
            if (
              !credential ||
              credential.role !== "primary" ||
              (input.accountId !== undefined &&
                credential.accountId !== input.accountId)
            )
              throw new HttpError(400, "first passkey authentication failed");
            const next = await verifyPasskeyLogin({
              credential,
              response: assertion,
              challenge: ch.challenge,
              rpId: config.rpId,
              origin: config.origin,
              userHandle: credential.userHandle,
              allowMissingUserHandle:
                session!.accountId === credential.accountId ||
                input.accountId === credential.accountId,
            });
            store.updateCounter(credential.id, credential.counter, next);
          }
          if (store.session(token)?.id !== session!.id)
            throw new HttpError(401, "sign-in session expired or revoked");
          const created = store.createSession(credential!.accountId, true);
          store.revokeSession(token);
          gateway.releaseSession?.(session!.id);
          setCookie(res, created.token);
          return json(res, 200, await projection(created));
        }
        if (path === "/v1/auth/logout") {
          exact(input, []);
          store.revokeSession(token);
          gateway.releaseSession?.(session!.id);
          res.setHeader(
            "set-cookie",
            `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          );
          return json(res, 200, { authenticated: false });
        }
        const registration = path.match(
          /^\/v1\/registrations\/(primary|secondary)\/(options|verify)$/,
        );
        if (registration) {
          const a = account(),
            r = role(registration[1]!);
          if (
            a.state !== "registering" ||
            store.credentials(a.id).some((c) => c.role === r)
          )
            throw new HttpError(
              409,
              "existing signer cannot be replaced through registration",
            );
          if (r === "secondary") requireSession(true);
          if (registration[2] === "options") {
            exact(input, []);
            const ch = store.createChallenge(session!.id, "registration", r);
            return json(res, 200, {
              sessionId: ch.id,
              challenge: ch.challenge,
              rpId: config.rpId,
              origin: config.origin,
              role: r,
              userVerification: "required",
              userHandle:
                r === "primary"
                  ? a.userHandle
                  : createHash("sha256")
                      .update(`vault-secondary:${a.userHandle}`)
                      .digest("base64url"),
              ...(r === "secondary"
                ? { authenticatorAttachment: "cross-platform" }
                : {}),
            });
          }
          exact(input, ["sessionId", "registration"]);
          if (typeof input.sessionId !== "string" || !input.registration)
            throw new HttpError(400, "registration response required");
          const ch = store.consumeChallenge(
              session!.id,
              input.sessionId,
              "registration",
              r,
            ),
            response = input.registration as RegistrationResponseJSON;
          const verified = await verifyPasskeyRegistration(
            {
              role: r,
              credentialId: response.id,
              challenge: ch.challenge,
              rpId: config.rpId,
              origin: config.origin,
              response,
            },
            undefined,
            { allowSyncedPrimary: true },
          );
          store.storeCredential(
            a.id,
            verified,
            r === "primary" ? a.userHandle : undefined,
          );
          return json(res, 200, {
            role: r,
            credentialId: verified.id,
            counter: verified.counter,
          });
        }
        requireSession(true);
        const a = account();
        if (path === "/v1/vaults/auto-provision") {
          exact(input, []);
          return json(res, 200, await gateway.provision(a.id));
        }
        if (path === "/v1/submissions/prepare")
          return json(
            res,
            200,
            await gateway.prepare(a.id, session!.id, input),
          );
        const submission = path.match(
          /^\/v1\/submissions\/([A-Za-z0-9._:-]{1,160})\/submit$/,
        );
        if (submission)
          return json(
            res,
            200,
            await gateway.submit(a.id, session!.id, submission[1]!, input),
          );
      }
      if (req.method === "GET") {
        requireSession(true);
        const a = account();
        if (path === "/v1/vaults/current") {
          const current = (await gateway.handlers(a.id)).currentVault?.();
          return current
            ? json(res, 200, current)
            : json(res, 404, { error: "vault is not provisioned" });
        }
        const match = path.match(
          /^\/v1\/submissions\/([A-Za-z0-9._:-]{1,160})$/,
        );
        if (match) return json(res, 200, await gateway.status(a.id, match[1]!));
      }
      throw new HttpError(404, "not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      // Errors can contain provider/user-controlled values: expose stable classes only.
      let message =
        error instanceof HttpError
          ? error.message
          : "account request failed safely";
      let code =
        status === 401
          ? "authentication_required"
          : status === 403
            ? "account_access_denied"
            : "account_request_failed";
      let stage = "account";
      if (!(error instanceof HttpError) && error instanceof Error) {
        if (
          error.message ===
          "automatic provisioning is still awaiting canonical confirmations for its recorded transaction"
        ) {
          code = "provisioning_pending_confirmation";
          stage = "provisioning-reconciliation";
          message = "Waiting for the recorded transaction to confirm";
        } else if (/Sepolia RPC request failed/.test(error.message)) {
          code = "rpc_request_failed";
          stage = "provisioning-rpc";
          message = "A Sepolia provider is temporarily unavailable";
        } else if (
          /provisioning (?:quote|relay) nonce mismatch|nonce drift before provisioning|deployer nonce does not equal|relay latest\/pending nonce changed/.test(
            error.message,
          )
        ) {
          code = "provisioning_nonce_mismatch";
          stage = "provisioning-recovery";
          message =
            "Verified deployment recovery is required before continuing";
        } else if (
          /unresolved|incomplete immutable deployment/.test(error.message)
        ) {
          code = "payer_reconciliation_required";
          stage = "payer";
          message =
            "Recorded transaction work must be reconciled before another submission";
        }
      }
      (options.log ?? writeBackendLog)({
          level: "error",
          requestId,
          method: req.method === "POST" ? "POST" : "GET",
          route: "account",
          status,
          code,
          stage,
          message,
      });
      json(res, status, { error: message, code, stage, requestId });
    }
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
