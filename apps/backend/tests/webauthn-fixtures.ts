import { hexToBytes, toHex } from "viem";

export function encodeP256CosePublicKey(
	coordinates: Readonly<{ x: bigint; y: bigint }>,
): Uint8Array {
	if (
		coordinates.x < 0n ||
		coordinates.y < 0n ||
		coordinates.x >= 1n << 256n ||
		coordinates.y >= 1n << 256n
	)
		throw new Error("P-256 coordinate is out of range");
	const x = hexToBytes(toHex(coordinates.x, { size: 32 }));
	const y = hexToBytes(toHex(coordinates.y, { size: 32 }));
	return Uint8Array.from([
		0xa5,
		0x01,
		0x02,
		0x03,
		0x26,
		0x20,
		0x01,
		0x21,
		0x58,
		0x20,
		...x,
		0x22,
		0x58,
		0x20,
		...y,
	]);
}
