import { expect } from "chai";
import { decodeFunctionData, isAddress, type Address } from "viem";
import { buildSafe4337RouteInstall, SAFE_ROUTE_INSTALL_ABI, type Safe4337RouteInstallInput } from "../../../../sdk/src/topology/safe4337-route-install";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const input: Safe4337RouteInstallInput = { safe: a(1), standardModule: a(2), router: a(3), delay: a(4), guard: a(5), multiSendCallOnly: a(6) };

describe("existing Safe 4337 route installation builder", () => {
  it("returns one unsigned Safe delegatecall containing every required topology change", () => {
    const plan = buildSafe4337RouteInstall(input);
    expect(plan.to).to.equal(input.multiSendCallOnly);
    expect(plan.value).to.equal(0n);
    expect(plan.operation).to.equal(1);
    const outer = decodeFunctionData({ abi: SAFE_ROUTE_INSTALL_ABI, data: plan.data });
    expect(outer.functionName).to.equal("multiSend");
    const packed = outer.args[0] as `0x${string}`;
    const operations: string[] = [];
    let cursor = 2;
    while (cursor < packed.length) {
      const op = packed.slice(cursor, cursor + 2); cursor += 2;
      const target = `0x${packed.slice(cursor, cursor + 40)}`; cursor += 40;
      const value = BigInt(`0x${packed.slice(cursor, cursor + 64)}`); cursor += 64;
      const length = Number(BigInt(`0x${packed.slice(cursor, cursor + 64)}`)); cursor += 64;
      const calldata = `0x${packed.slice(cursor, cursor + length * 2)}` as `0x${string}`; cursor += length * 2;
      expect(op).to.equal("00");
      expect(value).to.equal(0n);
      expect(isAddress(target)).to.equal(true);
      const decoded = decodeFunctionData({ abi: SAFE_ROUTE_INSTALL_ABI, data: calldata });
      operations.push(`${target.toLowerCase()}:${decoded.functionName}`);
    }
    expect(operations).to.deep.equal([
      `${input.safe.toLowerCase()}:disableModule`,
      `${input.safe.toLowerCase()}:enableModule`,
      `${input.safe.toLowerCase()}:enableModule`,
      `${input.safe.toLowerCase()}:setFallbackHandler`,
      `${input.safe.toLowerCase()}:setModuleGuard`,
      `${input.safe.toLowerCase()}:setGuard`,
    ]);
  });

  it("rejects zero or duplicate identities", () => {
    expect(() => buildSafe4337RouteInstall({ ...input, router: a(0) })).to.throw();
    expect(() => buildSafe4337RouteInstall({ ...input, router: input.standardModule })).to.throw();
  });
});
