import { expect } from "chai";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import {
  assertPwaProvisioningTransactionAuthorization,
  createLocalPhaseOneProvisioningAuthorizer,
  loadCommittedPwaProvisioningAutomationPolicy,
  type PwaProvisioningAuthorizationFacts,
} from "../../../src/pwa/authorization";
import {
  provisioningPackageHash,
  pwaProvisioningTransactionHash,
  writePwaProvisioningReview,
  type PwaProvisioningPlan,
} from "../../../src/pwa/provisioning";
import type { PwaProvisioningQuote } from "../../../src/pwa/provisioning-quote";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}` as Hex;
const hash = (n: number) => keccak256(hex(n));
const transaction = (id: string, nonce: bigint) => ({ id, nonce, to: address(10), value: 0n, data: hex(1), operation: 0 as const, description: id, expectedCreatedAddress: address(Number(nonce) + 20), creationCodeHash: hash(2), expectedRuntimeCodeHash: hash(3) });
const plan = {
  formatVersion: 1, chainId: 11155111, deployer: address(1), primaryPasskey: address(2), secondaryPasskey: address(3), safe: address(4), guard: address(5), delay: address(6), usdc: address(7),
  planHash: hash(8), deploymentsHash: hash(9), policyHash: hash(10), infrastructure: { passkeySignerVerifier: { address: address(8) } }, policy: {},
  transactions: [transaction("primary-signer", 1n), transaction("secondary-signer", 2n), transaction("setup-helper", 3n), transaction("guard", 4n), transaction("delay", 5n), transaction("maintenance", 6n), transaction("safe-proxy", 7n)],
  vaultPlan: { safeProxySaltNonce: 0n },
} as unknown as PwaProvisioningPlan;
const quote: PwaProvisioningQuote = Object.freeze({
  blockNumber: 100n,
  blockHash: hash(100),
  blockGasLimit: 100_000_000n,
  baseFeePerGas: 22n,
  estimates: [100n, 105n],
  priorityFeesPerGas: [2n, 3n],
  providers: ["provider-a", "provider-b"],
});
const facts: PwaProvisioningAuthorizationFacts = Object.freeze({
  chainId: 11155111,
  deployer: plan.deployer,
  deployerNonce: 1n,
  packageHash: provisioningPackageHash(plan),
  planHash: plan.planHash,
  confirmedActualCost: 1_000n,
  pendingReservation: 2_000n,
  relayBalance: 1_000_000n,
  authorizedAt: "2026-11-01T18:00:00.000Z",
});

describe("PWA provisioning review and transaction authorization", () => {
  it("writes one canonical immutable review package outside the repository", () => {
    const output = mkdtempSync(join(tmpdir(), "pwa-provisioning-review-"));
    const first = writePwaProvisioningReview(plan, output);
    const second = writePwaProvisioningReview(plan, output);
    expect(first).to.deep.equal(second);
    expect(JSON.parse(readFileSync(first.path, "utf8")).packageHash).to.equal(provisioningPackageHash(plan));
    expect(() => writePwaProvisioningReview(plan, process.cwd())).to.throw(/outside the repository/i);
  });

  it("authorizes one exact transaction from the dynamic quote and budget facts", async () => {
    const policy = loadCommittedPwaProvisioningAutomationPolicy();
    const authorization = await createLocalPhaseOneProvisioningAuthorizer(policy).authorizeTransaction(plan, plan.transactions[0]!, quote, facts);

    expect(authorization).to.include({
      formatVersion: 1,
      scope: "sepolia-pwa-provisioning-transaction",
      packageHash: facts.packageHash,
      planHash: plan.planHash,
      transactionId: "primary-signer",
      transactionHash: pwaProvisioningTransactionHash(plan.transactions[0]!),
      nonce: "1",
      quoteBlockNumber: "100",
      quoteBlockHash: hash(100),
      gasEstimateA: "100",
      gasEstimateB: "105",
      gasMarginBps: "3000",
      feeMarginBps: "3000",
      gasLimit: "137",
      maxFeePerGas: "62",
      maxPriorityFeePerGas: "4",
      priorOutlayWei: "3000",
      resultingOutlayWei: "11494",
      authorizedAt: facts.authorizedAt,
    });
    expect(authorization.providers).to.deep.equal(["provider-a", "provider-b"]);
    expect(authorization.authorizationHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(assertPwaProvisioningTransactionAuthorization(plan, authorization)).to.deep.equal(authorization);
  });

  it("rejects authorization mutations and plan/transaction mismatches", async () => {
    const authorizer = createLocalPhaseOneProvisioningAuthorizer();
    const authorization = await authorizer.authorizeTransaction(plan, plan.transactions[0]!, quote, facts);
    for (const changed of [
      { ...authorization, packageHash: hash(90) },
      { ...authorization, transactionHash: hash(91) },
      { ...authorization, nonce: "2" },
      { ...authorization, gasLimit: "138" },
      { ...authorization, providers: ["provider-b", "provider-a"] },
      { ...authorization, unexpected: true },
    ]) expect(() => assertPwaProvisioningTransactionAuthorization(plan, changed)).to.throw();

    await expect(authorizer.authorizeTransaction(plan, plan.transactions[1]!, quote, facts)).to.be.rejectedWith(/nonce|transaction/i);
    await expect(authorizer.authorizeTransaction(plan, plan.transactions[0]!, quote, { ...facts, packageHash: hash(92) })).to.be.rejectedWith(/package/i);
  });
});
