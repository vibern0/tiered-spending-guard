import type { FastifyBaseLogger } from "fastify";
import { createBackendLogger } from "../logging";

/**
 * Run a background sweep immediately and schedule the next attempt after each completion.
 * Failures produce a sanitized warning; sweeps never overlap within this worker.
 * @returns A stop operation that cancels scheduling and waits for the current sweep.
 */
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
	/** Start one sweep and schedule its successor only after that attempt settles. */
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
		/** Prevent further sweeps and drain the currently running attempt. */
		stop: async () => {
			stopped = true;
			if (timer) {
				clearTimeout(timer);
			}
			await flight;
		},
	});
}
