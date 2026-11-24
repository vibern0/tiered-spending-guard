import { isAddress, type Address } from "viem";
/** Provider output can supply prices/limits only, never the transaction being approved. */
export function providerFields(
  input: unknown,
  kind: "gas" | "sponsor",
  paymaster: Address,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("Malformed provider response.");
  const allowed =
    kind === "gas"
      ? [
          "callGasLimit",
          "verificationGasLimit",
          "preVerificationGas",
          "paymasterVerificationGasLimit",
          "paymasterPostOpGasLimit",
        ]
      : [
          "paymaster",
          "paymasterData",
          "paymasterVerificationGasLimit",
          "paymasterPostOpGasLimit",
          "isFinal",
          "sponsor",
        ];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key))
      throw Error(`Unexpected provider field: ${key}`);
    if (["isFinal", "sponsor"].includes(key)) continue;
    if (key === "paymaster") {
      if (
        typeof value !== "string" ||
        !isAddress(value) ||
        value.toLowerCase() !== paymaster.toLowerCase()
      )
        throw Error("Unexpected sponsor.");
      out[key] = value;
    } else if (key === "paymasterData") {
      if (
        typeof value !== "string" ||
        !/^0x(?:[\da-f]{2})*$/i.test(value) ||
        value.length > 8194
      )
        throw Error("Invalid sponsor data.");
      out[key] = value;
    } else {
      if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value))
        throw Error("Invalid gas estimate.");
      const number = BigInt(value);
      if (number < 0n || number > 12_000_000n)
        throw Error("Gas estimate outside local budget.");
      out[key] = number;
    }
  }
  if (
    kind === "gas" &&
    !["callGasLimit", "verificationGasLimit", "preVerificationGas"].every(
      (k) => k in out,
    )
  )
    throw Error("Incomplete gas estimate.");
  if (
    kind === "sponsor" &&
    ![
      "paymaster",
      "paymasterData",
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
    ].every((k) => k in out)
  )
    throw Error("Incomplete sponsorship response.");
  return out;
}

export class RpcRejection extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}
