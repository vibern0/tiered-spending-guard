import { expect } from "chai";
import { type Address, type Hex } from "viem";
import { encodeCallOnlyBatch, type UnsignedSetupCall } from "../../../../sdk/src/topology/multisend";

const a = (n: number) => (`0x${n.toString(16).padStart(40, "0")}`) as Address;

describe("call-only batch", () => {
  it("packs Safe MultiSendCallOnly records byte-identically and in order", () => {
    const calls: readonly UnsignedSetupCall[] = [
      { to: a(1), value: 0n, data: "0x1234" as Hex, operation: 0 },
      { to: a(2), value: 7n, data: "0xabcdef" as Hex, operation: 0 },
    ];

    expect(encodeCallOnlyBatch(calls)).to.equal(
      "0x" +
        "00" + "0000000000000000000000000000000000000001" + "0".repeat(64) + "0".repeat(63) + "2" + "1234" +
        "00" + "0000000000000000000000000000000000000002" + "0".repeat(63) + "7" + "0".repeat(63) + "3" + "abcdef",
    );
  });

  it("rejects empty setup, delegatecall, malformed hex data, invalid targets, and negative values", () => {
    const valid: UnsignedSetupCall = { to: a(1), value: 0n, data: "0x" as Hex, operation: 0 };

    expect(() => encodeCallOnlyBatch([])).to.throw("at least one setup call");
    expect(() => encodeCallOnlyBatch([{ ...valid, operation: 1 }])).to.throw("CALL");
    expect(() => encodeCallOnlyBatch([{ ...valid, data: "0x123" as Hex }])).to.throw("byte-aligned");
    expect(() => encodeCallOnlyBatch([{ ...valid, to: "0x123" as Address }])).to.throw("valid address");
    expect(() => encodeCallOnlyBatch([{ ...valid, value: -1n }])).to.throw("non-negative");
  });
});
