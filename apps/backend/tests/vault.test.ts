import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { prepareUsdcTransfer } from "../src/compatibility/submission";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const GUARD = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x3333333333333333333333333333333333333333" as Address;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

const input = {
	chainId: 11155111,
	safe: SAFE,
	guard: GUARD,
	usdc: USDC,
	configuredUsdc: USDC,
	recipient: RECIPIENT,
	amount: 1000000n,
	nonce: 3n,
	deploymentHash: HASH,
	policyHash: HASH,
	idempotencyKey: HASH,
	signatures: `0x${"11".repeat(65)}` as Hex,
	expectedSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n },
	allowedRecipients: [RECIPIENT],
};

describe("bounded backend vault requests", () => {
	it("prepares exactly one USDC transfer Safe call", async () => {
		const request = await prepareUsdcTransfer(input);
		expect(request.safe).toBe(SAFE);
		expect(request.asset).toBe(USDC);
		expect(request.transaction.to).toBe(USDC);
		expect(request.transaction.value).toBe(0n);
		expect(request.transaction.operation).toBe(0);
		expect(request.transaction.gasPrice).toBe(0n);
	});

	it.each([
		[
			"unknown recipient",
			{ recipient: "0x5555555555555555555555555555555555555555" as Address },
		],
		["zero Safe value", { nativeValue: 1n }],
		[
			"wrong asset",
			{ configuredUsdc: "0x6666666666666666666666666666666666666666" as Address },
		],
		["arbitrary data", { data: "0x12345678" as Hex }],
	])("rejects %s", async (_name, mutation) => {
		await expect(prepareUsdcTransfer({ ...input, ...mutation } as never)).rejects.toThrow();
	});
});
