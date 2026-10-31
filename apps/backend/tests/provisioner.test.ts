import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { pwaProvisioningApprovalHash, provisioningPackageHash, type PwaProvisioningPlan } from "@recent-tx-safe-guard/security-core/pwa";
import { createReviewedPwaProvisioner } from "../src/provisioner";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}` as Hex;
const hash = (n: number) => keccak256(hex(n));

describe("reviewed PWA provisioner", () => {
  it("rejects approval bytes changed after an independent digest was recorded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reviewed-pwa-provisioner-"));
    const approvalPath = join(directory, "approval.json");
    const approvalHashPath = join(directory, "approval.hash");
    const transaction = { id: "primary-signer", nonce: 1n, to: address(2), value: 0n, data: hex(1), operation: 0, description: "primary", expectedCreatedAddress: address(3), creationCodeHash: hash(2), expectedRuntimeCodeHash: hash(3) };
    const plan = { formatVersion: 1, chainId: 11155111, deployer: address(1), primaryPasskey: address(3), secondaryPasskey: address(4), safe: address(5), guard: address(6), delay: address(7), usdc: address(8), deploymentsHash: hash(4), policyHash: hash(5), planHash: hash(6), infrastructure: {}, policy: {}, transactions: [transaction], vaultPlan: { review: {} } } as unknown as PwaProvisioningPlan;
    const baseApproval = { formatVersion: 1, scope: "sepolia-pwa-provisioning", packageHash: provisioningPackageHash(plan), planHash: plan.planHash, transactions: [{ id: "primary-signer", nonce: "1", gasLimit: "100000", maxFeePerGas: "2", maxPriorityFeePerGas: "1" }] };
    writeFileSync(approvalPath, JSON.stringify(baseApproval));
    writeFileSync(approvalHashPath, `${pwaProvisioningApprovalHash(plan, baseApproval)}\n`);
    writeFileSync(approvalPath, JSON.stringify({ ...baseApproval, transactions: [{ ...baseApproval.transactions[0], gasLimit: "100001" }] }));
    const executionContext = vi.fn();
    const provisioner = createReviewedPwaProvisioner({ reviewDirectory: join(directory, "reviews"), approvalPath, approvalHashPath, createPlan: async () => plan, executionContext });
    const publicKey = new Uint8Array([1]);
    const planned = await provisioner.plan({ primary: { role: "primary", id: "p", publicKey, counter: 0, x: 1n, y: 2n }, secondary: { role: "secondary", id: "s", publicKey, counter: 0, x: 3n, y: 4n } });
    await expect(provisioner.execute({ packageHash: planned.packageHash })).rejects.toThrow(/independently reviewed hash/i);
    expect(executionContext).not.toHaveBeenCalled();
  });
});
