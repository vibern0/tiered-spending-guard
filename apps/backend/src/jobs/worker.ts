import type { FastifyBaseLogger } from "fastify";
import { createBackendLogger } from "../logging";

/** Retry each task only after completion, never alongside an earlier sweep. */
export function startBackgroundWorker(
	name: "receipt" | "provisioning" | "history",
	reconcilePending: () => Promise<void>,
	options: Readonly<{ logger?: FastifyBaseLogger }> = {},
): Readonly<{ stop(): Promise<void> }> {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let flight: Promise<void>;
	const logger =
		options.logger ??
		createBackendLogger({ level: process.env.NODE_ENV === "test" ? "silent" : "info" });
	const run = () => {
		flight = Promise.resolve()
			.then(reconcilePending)
			.catch(() => {
				logger.warn(
					{
						code: `${name}_worker_failed`,
						stage: name,
					},
					"Background verification failed safely; retrying later",
				);
			})
			.finally(() => {
				if (!stopped) {
					timer = setTimeout(run, 12_000);
					timer.unref();
				}
			});
	};
	run();
	return Object.freeze({
		stop: async () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			await flight;
		},
	});
}
