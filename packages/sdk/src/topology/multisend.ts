import { concatHex, isAddress, numberToHex, padHex, size, type Address, type Hex } from "viem";

export type UnsignedSetupCall = Readonly<{ to: Address; value: bigint; data: Hex; operation: 0 | 1 }>;

export function encodeCallOnlyBatch(_calls: readonly UnsignedSetupCall[]): Hex {
  if (_calls.length === 0) throw new Error("at least one setup call is required");
  const encoded = _calls.map((call, index) => {
    if (call.operation !== 0) throw new Error(`setup call ${index} must use CALL`);
    if (!isAddress(call.to)) throw new Error(`setup call ${index} target must be a valid address`);
    if (call.value < 0n) throw new Error(`setup call ${index} value must be non-negative`);
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data)) throw new Error(`setup call ${index} data must be byte-aligned hex`);
    return concatHex([
      "0x00",
      call.to,
      padHex(numberToHex(call.value), { size: 32 }),
      padHex(numberToHex(size(call.data)), { size: 32 }),
      call.data,
    ]);
  });
  return concatHex(encoded);
}
