import { expect } from "chai";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import {
  assertPwaProvisioningApproval,
  pwaProvisioningApprovalHash,
  provisioningPackageHash,
  writePwaProvisioningReview,
  type PwaProvisioningPlan,
} from "../../../src/pwa/provisioning";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}` as Hex;
const transaction = (id: string, nonce: bigint) => ({ id, nonce, to: address(10), value: 0n, data: hex(1), operation: 0 as const, description: id, expectedCreatedAddress: address(Number(nonce) + 20), creationCodeHash: keccak256(hex(2)), expectedRuntimeCodeHash: keccak256(hex(3)) });
const plan = {
  formatVersion: 1, chainId: 11155111, deployer: address(1), primaryPasskey: address(2), secondaryPasskey: address(3), safe: address(4), guard: address(5), delay: address(6), usdc: address(7),
  planHash: keccak256(hex(8)), infrastructure: { passkeySignerVerifier: { address: address(8) } },
  transactions: [transaction("primary-signer", 1n), transaction("secondary-signer", 2n), transaction("setup-helper", 3n), transaction("guard", 4n), transaction("delay", 5n), transaction("maintenance", 6n), transaction("safe-proxy", 7n)],
  vaultPlan: {},
} as unknown as PwaProvisioningPlan;

function approval() {
  return { formatVersion: 1, scope: "sepolia-pwa-provisioning", packageHash: provisioningPackageHash(plan), planHash: plan.planHash, transactions: plan.transactions.map(({ id, nonce }) => ({ id, nonce: nonce.toString(), gasLimit: "1", maxFeePerGas: "2", maxPriorityFeePerGas: "1" })) };
}

describe("PWA provisioning review approval", () => {
  it("writes a canonical review package outside the repository and binds its hash", () => {
    const output = mkdtempSync(join(tmpdir(), "pwa-provisioning-review-"));
    const first = writePwaProvisioningReview(plan, output);
    const second = writePwaProvisioningReview(plan, output);
    expect(first).to.deep.equal(second);
    expect(first.packageHash).to.equal(provisioningPackageHash(plan));
    expect(JSON.parse(readFileSync(first.path, "utf8")).packageHash).to.equal(first.packageHash);
    expect(() => writePwaProvisioningReview(plan, process.cwd())).to.throw(/outside the repository/i);
  });

  it("requires exact package, plan, transaction order, nonce, and fee approval fields", () => {
    expect(assertPwaProvisioningApproval(plan, approval())).to.deep.equal(approval());
    for (const changed of [
      { ...approval(), packageHash: keccak256(hex(9)) },
      { ...approval(), planHash: keccak256(hex(9)) },
      { ...approval(), transactions: approval().transactions.slice(0, 6) },
      { ...approval(), transactions: approval().transactions.map((item, index) => index === 0 ? { ...item, nonce: "2" } : item) },
      { ...approval(), transactions: approval().transactions.map((item, index) => index === 0 ? { ...item, gasLimit: "01" } : item) },
      { ...approval(), unexpected: true },
    ]) expect(() => assertPwaProvisioningApproval(plan, changed)).to.throw();

    const changedRuntime = {
      ...plan,
      transactions: plan.transactions.map((item, index) => index === 3 ? { ...item, expectedRuntimeCodeHash: keccak256(hex(10)) } : item),
    } as PwaProvisioningPlan;
    expect(provisioningPackageHash(changedRuntime)).not.to.equal(provisioningPackageHash(plan));
    expect(() => assertPwaProvisioningApproval(changedRuntime, approval())).to.throw(/hash/i);

    const changedFee = { ...approval(), transactions: approval().transactions.map((item, index) => index === 0 ? { ...item, gasLimit: "2" } : item) };
    expect(pwaProvisioningApprovalHash(plan, changedFee)).not.to.equal(pwaProvisioningApprovalHash(plan, approval()));
  });
});
