import { createBackendLogger } from "../src/logging";

export function captureBackendLogs(target?: unknown[]) {
	const entries: Record<string, any>[] = [];
	const logger = createBackendLogger({
		stream: {
			write: (line: string) => {
				const entry = JSON.parse(line);
				entries.push(entry);
				target?.push(entry);
			},
		},
	});
	return { logger, entries };
}
