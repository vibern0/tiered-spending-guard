import { AccountHttpError } from "../auth/errors";

export function sanitizeBackendMessage(error: unknown): string {
	if (!(error instanceof Error)) return "backend request failed";
	return error.message
		.replace(/https?:\/\/[^\s]+/gi, "[redacted]")
		.replace(/0x[0-9a-fA-F]{64}/g, "[redacted]");
}
export function diagnosticFor(message: string): Readonly<{ code: string; stage: string }> {
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

export function accountError(error: unknown): Readonly<{ status: number; message: string }> {
	if (error instanceof AccountHttpError) return error;
	const status = (error as { statusCode?: number }).statusCode;
	if (status === 413) return { status, message: "request too large" };
	if (status === 415) return { status, message: "JSON request required" };
	return { status: 400, message: "account request failed safely" };
}
