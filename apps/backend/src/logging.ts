import pino, { type DestinationStream } from "pino";

/**
 * Create the backend logger with restricted request/error serializers and secret-field redaction.
 * Pretty output is optional; raw provider errors and request payloads must not reach logs.
 */
export function createBackendLogger(
	options: Readonly<{
		pretty?: boolean;
		level?: "info" | "silent";
		stream?: DestinationStream;
	}> = {},
) {
	return pino(
		{
			level: options.level ?? "info",
			hooks: {
				/**
				 * Supply a safe default message before Pino can derive one from an untrusted error.
				 */
				logMethod(args, method) {
					const first = args[0];
					// Pino derives an implicit msg from the raw error before serializers run.
					if (
						args[1] === undefined &&
						(first instanceof Error ||
							(first && typeof first === "object" && "err" in first))
					) {
						method.call(this, first, "Backend operation failed");
					} else {
						method.apply(this, args);
					}
				},
			},
			serializers: {
				/** Keep only a closed HTTP method and route name from each request. */
				req: (request: { method?: string; url?: string }) => ({
					method: ["GET", "POST", "OPTIONS"].includes(request.method ?? "")
						? request.method
						: "OTHER",
					route: backendLogRoute(request.url),
				}),
				/** Log response status without exposing response headers or payloads. */
				res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
				/** Replace raw errors so provider details, payloads, causes, and stacks stay private. */
				err: () => ({ type: "Error", message: "Backend operation failed" }),
			},
			redact: {
				paths: [
					"headers",
					"body",
					"authorization",
					"cookie",
					"relayPrivateKey",
					"rpcUrl",
					"req.headers",
					"req.body",
					"res.headers",
				],
				remove: true,
			},
			...(options.pretty
				? {
						transport: {
							target: "pino-pretty",
							options: {
								colorize: process.stdout.isTTY === true,
								translateTime: "HH:MM:ss",
								ignore: "pid,hostname",
							},
						},
					}
				: {}),
		},
		options.stream,
	);
}

// Log only closed route names. Never copy user-controlled paths or identifiers.
/**
 * Map a request URL to a closed route name so logs omit query strings and arbitrary identifiers.
 */
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
	) {
		return path;
	}
	const registration = /^\/v1\/registrations\/(primary|secondary)\/(options|verify)$/.exec(path);
	if (registration) {
		return `/v1/registrations/${registration[1]}/${registration[2]}`;
	}
	const rebind = /^\/v1\/credentials\/(primary|secondary)\/rebind\/(options|verify)$/.exec(path);
	if (rebind) {
		return `/v1/credentials/${rebind[1]}/rebind/${rebind[2]}`;
	}
	if (/^\/v1\/submissions\/[A-Za-z0-9._:-]{1,160}\/submit$/.test(path)) {
		return "/v1/submissions/:id/submit";
	}
	if (/^\/v1\/submissions\/[A-Za-z0-9._:-]{1,160}$/.test(path)) {
		return "/v1/submissions/:id";
	}
	if (
		path === "/documentation" ||
		path === "/documentation/" ||
		path === "/documentation/json" ||
		path === "/documentation/yaml"
	) {
		return path;
	}
	if (path.startsWith("/documentation/static/")) {
		return "/documentation/static/*";
	}
	return "unmatched";
}
