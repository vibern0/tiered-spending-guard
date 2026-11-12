import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BackendConfig } from "../config";
import { isLoopbackAddress } from "../config";
import type {
	AccountRecord,
	AccountSession,
	AccountStore,
	NewAccountSession,
} from "../account-store";
import type { BackendPasskeyRole } from "../webauthn";

const COOKIE = "vault_local_session";

export class AccountHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).sort().join() !== [...keys].sort().join())
		throw new AccountHttpError(400, "unsupported request fields");
}

export function passkeyRole(value: string): BackendPasskeyRole {
	if (value !== "primary" && value !== "secondary") throw new AccountHttpError(404, "not found");
	return value;
}

export function submissionId(value: string): string {
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new AccountHttpError(404, "not found");
	return value;
}

type RequestState = {
	token: string;
	session: AccountSession | undefined;
};

function cookie(request: FastifyRequest): string {
	const values = (request.headers.cookie ?? "")
		.split(";")
		.map((value) => value.trim())
		.filter((value) => value.startsWith(`${COOKIE}=`));
	return values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : "";
}

export class AccountRouteContext {
	private readonly requests = new WeakMap<FastifyRequest, RequestState>();

	constructor(private readonly store: AccountStore) {}

	state(request: FastifyRequest): RequestState {
		const existing = this.requests.get(request);
		if (existing) return existing;
		const token = cookie(request);
		const state = { token, session: this.store.session(token) };
		this.requests.set(request, state);
		return state;
	}

	session(request: FastifyRequest, authenticated = false): AccountSession {
		const session = this.state(request).session;
		if (!session || (authenticated && !session.authenticated))
			throw new AccountHttpError(401, "sign in with your first passkey");
		return session;
	}

	account(request: FastifyRequest): AccountRecord {
		const session = this.session(request);
		if (!session.accountId || request.headers["x-vault-account"] !== session.accountId)
			throw new AccountHttpError(403, "account does not match session");
		return this.store.account(session.accountId)!;
	}

	replaceSession(request: FastifyRequest, session: NewAccountSession): void {
		this.requests.set(request, { token: session.token, session });
	}

	setCookie(reply: FastifyReply, token: string): void {
		reply.header("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`);
	}

	clearCookie(reply: FastifyReply): void {
		reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
	}
}

export function registerAccountSecurity(
	fastify: FastifyInstance,
	config: BackendConfig,
	store: AccountStore,
	context: AccountRouteContext,
): void {
	fastify.addHook("onRequest", async (request, reply) => {
		if (!isLoopbackAddress(request.raw.socket.remoteAddress))
			throw new AccountHttpError(403, "loopback only");
		const bound = (fastify.server.address() as { port: number } | null)?.port ?? config.port;
		if (![`localhost:${bound}`, `127.0.0.1:${bound}`].includes(request.headers.host ?? ""))
			throw new AccountHttpError(403, "host not allowed");
		const origin = request.headers.origin;
		if (origin !== undefined && origin !== config.origin)
			throw new AccountHttpError(403, "origin not allowed");
		if (origin !== undefined) {
			reply.header("access-control-allow-origin", config.origin);
			reply.header("access-control-allow-credentials", "true");
			reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
			reply.header(
				"access-control-allow-headers",
				"content-type,x-csrf-token,x-vault-account",
			);
			reply.header("vary", "Origin");
		}
		if (request.method === "OPTIONS") {
			await reply.code(204).send();
			return;
		}
		const path = request.raw.url?.split("?", 1)[0] ?? "/";
		if (request.raw.url !== path) throw new AccountHttpError(404, "not found");
		context.state(request);
		if (request.method === "POST") {
			if (origin !== config.origin)
				throw new AccountHttpError(403, "exact browser origin required");
			if (!["/v1/auth/setup", "/v1/auth/login/options"].includes(path)) {
				const session = context.session(request);
				try {
					store.assertCsrf(session, request.headers["x-csrf-token"]);
				} catch {
					throw new AccountHttpError(403, "invalid session CSRF token");
				}
			}
		}
	});
}
