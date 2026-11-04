import { expect } from "chai";
import { copyFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import {
  loadCommittedPwaProvisioningSuccessor,
  loadCommittedPwaProvisioningSuccessors,
  loadPwaProvisioningSuccessor,
  provisioningPackageHash,
  resolvePwaProvisioningRecovery,
  writePwaProvisioningReview,
  type PwaProvisioningPlan,
  type PwaProvisioningRecoveryClient,
  type PwaProvisioningTransaction,
} from "../../../src/pwa";
import { liveIntentHash, type LiveJournal } from "../../../scripts/live/submission";

const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const bytes = (value: number) => `0x60${value.toString(16).padStart(2, "0")}` as Hex;
const hash = (value: number) => keccak256(bytes(value));
const deployer = address(1);
const factory = address(2);
const verifier = address(3);
const firstNonce = 959n;
const ids = ["primary-signer", "secondary-signer", "setup-helper", "guard", "delay", "maintenance", "safe-proxy"] as const;
const createSignerAbi = [{ name: "createSigner", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint176" }], outputs: [{ type: "address" }] }] as const;
const primary = Object.freeze({ x: 11n, y: 12n });
const secondary = Object.freeze({ x: 21n, y: 22n });

function transaction(id: typeof ids[number], index: number): PwaProvisioningTransaction {
  const credential = index === 0 ? primary : secondary;
  const data = index < 2
    ? encodeFunctionData({ abi: createSignerAbi, functionName: "createSigner", args: [credential.x, credential.y, BigInt(verifier)] })
    : bytes(40 + index);
  return Object.freeze({
    id,
    nonce: firstNonce + BigInt(index),
    description: id,
    to: index < 2 ? factory : address(20 + index),
    value: 0n,
    operation: 0 as const,
    data,
    expectedCreatedAddress: address(100 + index),
    creationCodeHash: keccak256(data),
    expectedRuntimeCodeHash: keccak256(bytes(100 + index)),
  });
}

const transactions = Object.freeze(ids.map(transaction));
const plan = Object.freeze({
  formatVersion: 1,
  chainId: 11155111,
  deployer,
  primaryPasskey: transactions[0]!.expectedCreatedAddress,
  secondaryPasskey: transactions[1]!.expectedCreatedAddress,
  safe: transactions[6]!.expectedCreatedAddress,
  guard: transactions[3]!.expectedCreatedAddress,
  delay: transactions[4]!.expectedCreatedAddress,
  usdc: address(200),
  deploymentsHash: hash(201),
  policyHash: hash(202),
  planHash: hash(203),
  policy: {},
  infrastructure: {},
  transactions,
  vaultPlan: { review: { policyHash: hash(202) } },
} as unknown as PwaProvisioningPlan);

const gas = (index: number) => 100_000n + BigInt(index);
const maxFee = (index: number) => 2_000_000_000n + BigInt(index);
const tip = (index: number) => 1_000_000_000n + BigInt(index);
const blockNumber = (index: number) => 90n + BigInt(index);
const blockHash = (index: number) => hash(10 + index);
const transactionHash = (index: number) => hash(30 + index);
const successorTransactionHash = (index: number) => hash(130 + index);
const prefixOneSuccessorTransactionHash = (index: number) => hash(180 + index);
const consumedHashes = [hash(240), hash(241), hash(242)] as const;
const consumedBlocks = [80n, 81n, 82n] as const;

const successorTransactions = Object.freeze(transactions.map((item, index) => index < 2 ? item : Object.freeze({
  ...item,
  nonce: item.nonce + 3n,
  expectedCreatedAddress: address(150 + index),
  data: bytes(140 + index),
  creationCodeHash: keccak256(bytes(140 + index)),
})));
const successorPlan = Object.freeze({ ...plan, planHash: hash(249), transactions: successorTransactions }) as PwaProvisioningPlan;

const prefixOneSuccessorTransactions = Object.freeze(transactions.map((item, index) => {
  if (index === 0) return item;
  if (index === 1) return Object.freeze({ ...item, nonce: firstNonce + 2n });
  return Object.freeze({
    ...item,
    nonce: firstNonce + 1n + BigInt(index),
    expectedCreatedAddress: address(170 + index),
    data: bytes(160 + index),
    creationCodeHash: keccak256(bytes(160 + index)),
  });
}));
const prefixOneSuccessorPlan = Object.freeze({ ...plan, planHash: hash(248), transactions: prefixOneSuccessorTransactions }) as PwaProvisioningPlan;

function plannedTransactionHash(value: PwaProvisioningPlan, index: number): Hex {
  if (value === successorPlan && index >= 2) return successorTransactionHash(index);
  if (value === prefixOneSuccessorPlan && index >= 1) return prefixOneSuccessorTransactionHash(index);
  return transactionHash(index);
}

const successorValue = Object.freeze({
  formatVersion: 1,
  scope: "sepolia-pwa-provisioning-successor",
  chainId: 11155111,
  originalPackageHash: provisioningPackageHash(plan),
  confirmedPrefixLength: 2,
  consumedTransactions: [
    { nonce: "961", transactionHash: consumedHashes[0] },
    { nonce: "962", transactionHash: consumedHashes[1] },
    { nonce: "963", transactionHash: consumedHashes[2] },
  ],
  expectedNextNonce: "964",
});

const prefixOneSuccessorValue = Object.freeze({
  formatVersion: 1,
  scope: "sepolia-pwa-provisioning-successor",
  chainId: 11155111,
  originalPackageHash: provisioningPackageHash(plan),
  confirmedPrefixLength: 1,
  consumedTransactions: [{ nonce: "960", transactionHash: consumedHashes[0] }],
  expectedNextNonce: "961",
});

function journal(prefixLength: number, value: PwaProvisioningPlan = plan): LiveJournal {
  return {
    chainId: 11155111,
    funder: deployer,
    entries: value.transactions.slice(0, prefixLength).map((item, index) => {
      const intent = {
        id: `pwa-${item.id}`,
        to: item.to,
        data: item.data,
        value: item.value,
        nonce: Number(item.nonce),
        gas: gas(index),
        maxFeePerGas: maxFee(index),
        maxPriorityFeePerGas: tip(index),
      };
      return {
        id: intent.id,
        intentHash: liveIntentHash(intent, deployer),
        transactionHash: plannedTransactionHash(value, index),
        nonce: intent.nonce,
        reserved: (gas(index) - 1n) * (maxFee(index) - 1n),
        status: "success" as const,
        receipt: {
          transactionHash: plannedTransactionHash(value, index),
          status: "success" as const,
          gasUsed: gas(index) - 1n,
          effectiveGasPrice: maxFee(index) - 1n,
          blockNumber: blockNumber(index),
          blockHash: blockHash(index),
        },
      };
    }),
  };
}

type Overrides = Readonly<{
  head?: bigint;
  nonce?: bigint;
  mutateTransaction?: (index: number, value: Record<string, unknown>) => Record<string, unknown>;
  mutateReceipt?: (index: number, value: Record<string, unknown>) => Record<string, unknown>;
  mutateRuntime?: (index: number, value: Hex | undefined) => Hex | undefined;
  mutateConsumedTransaction?: (index: number, value: Record<string, unknown>) => Record<string, unknown>;
  mutateConsumedReceipt?: (index: number, value: Record<string, unknown>) => Record<string, unknown>;
  codeAt?: Address;
}>;

function evidenceClient(source: string, prefixLength: number, overrides: Overrides = {}, value: PwaProvisioningPlan = plan): PwaProvisioningRecoveryClient {
  return {
    source,
    async getChainId() { return 11155111; },
    async getBlockNumber() { return overrides.head ?? 110n; },
    async getBlock({ blockNumber: number }) {
      const consumedIndex = consumedBlocks.findIndex((value) => value === number);
      if (consumedIndex >= 0) return { number, hash: hash(70 + consumedIndex) };
      const index = Number(number - 90n);
      return { number, hash: blockHash(index) };
    },
    async getTransaction({ hash: requested }) {
      const consumedIndex = consumedHashes.findIndex((value) => value === requested);
      if (consumedIndex >= 0) {
        const value: Record<string, unknown> = { hash: requested, chainId: 11155111, type: "eip1559", from: deployer, to: address(240 + consumedIndex), nonce: 961 + consumedIndex, value: 0n, input: bytes(220 + consumedIndex), gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
        return (overrides.mutateConsumedTransaction?.(consumedIndex, value) ?? value) as never;
      }
      const index = value.transactions.findIndex((_item, candidate) => plannedTransactionHash(value, candidate) === requested);
      if (index < 0) return null;
      const item = value.transactions[index]!;
      const transactionValue: Record<string, unknown> = {
        hash: requested,
        chainId: 11155111,
        type: "eip1559",
        from: deployer,
        to: item.to,
        nonce: Number(item.nonce),
        value: item.value,
        input: item.data,
        gas: gas(index),
        maxFeePerGas: maxFee(index),
        maxPriorityFeePerGas: tip(index),
      };
      return (overrides.mutateTransaction?.(index, transactionValue) ?? transactionValue) as never;
    },
    async getTransactionReceipt({ hash: requested }) {
      const consumedIndex = consumedHashes.findIndex((value) => value === requested);
      if (consumedIndex >= 0) {
        const value: Record<string, unknown> = { transactionHash: requested, status: "success", gasUsed: 21_000n, effectiveGasPrice: 1_500_000_000n, blockNumber: consumedBlocks[consumedIndex], blockHash: hash(70 + consumedIndex) };
        return (overrides.mutateConsumedReceipt?.(consumedIndex, value) ?? value) as never;
      }
      const index = value.transactions.findIndex((_item, candidate) => plannedTransactionHash(value, candidate) === requested);
      if (index < 0) return null;
      const receiptValue: Record<string, unknown> = {
        transactionHash: requested,
        status: "success",
        gasUsed: gas(index) - 1n,
        effectiveGasPrice: maxFee(index) - 1n,
        blockNumber: blockNumber(index),
        blockHash: blockHash(index),
      };
      return (overrides.mutateReceipt?.(index, receiptValue) ?? receiptValue) as never;
    },
    async getBytecode({ address: target }) {
      if (overrides.codeAt && overrides.codeAt.toLowerCase() === target.toLowerCase()) return bytes(252);
      const index = value.transactions.findIndex((item) => item.expectedCreatedAddress.toLowerCase() === target.toLowerCase());
      const runtime = index >= 0 && index < prefixLength ? bytes(100 + index) : undefined;
      return overrides.mutateRuntime?.(index, runtime) ?? runtime;
    },
    async getTransactionCount() { return overrides.nonce ?? firstNonce + BigInt(prefixLength); },
    async readContract() { throw new Error("test recovery rebuild must not use RPC planning"); },
    async call() { throw new Error("test recovery rebuild must not use RPC planning"); },
  };
}

function successorFixture(firstOverrides: Overrides = {}, secondOverrides: Overrides = {}, prefixLength = 2) {
  const nextNonce = successorPlan.transactions[prefixLength]?.nonce ?? successorPlan.transactions.at(-1)!.nonce + 1n;
  const base = fixture(prefixLength, { nonce: nextNonce, ...firstOverrides }, { nonce: nextNonce, ...secondOverrides }, successorPlan);
  return {
    ...base,
    successor: loadPwaProvisioningSuccessor(successorValue),
    relay: evidenceClient("relay", prefixLength, { nonce: nextNonce }, successorPlan),
    rebuildPlan: async ({ prerequisiteStartingNonce }: { prerequisiteStartingNonce?: bigint }) => prerequisiteStartingNonce === firstNonce + 5n ? successorPlan : plan,
  };
}

function fixture(prefixLength: number, firstOverrides: Overrides = {}, secondOverrides: Overrides = {}, value: PwaProvisioningPlan = plan) {
  process.env.NODE_ENV = "test";
  const directory = mkdtempSync(join(tmpdir(), "pwa-recovery-"));
  writePwaProvisioningReview(plan, directory);
  return {
    reviewDirectory: directory,
    journal: journal(prefixLength, value),
    profile: {} as never,
    safeProxySaltNonce: 0n,
    providers: [evidenceClient("provider-a", prefixLength, firstOverrides, value), evidenceClient("provider-b", prefixLength, secondOverrides, value)] as const,
    relay: evidenceClient("relay", prefixLength, {}, value),
    rebuildPlan: async ({ credentials, expectedDeployerNonce, confirmedPrefixLength }: { credentials: { primary: typeof primary; secondary: typeof secondary }; expectedDeployerNonce: bigint; confirmedPrefixLength: number }) => {
      expect(credentials).to.deep.equal({ primary, secondary });
      expect(expectedDeployerNonce).to.equal(firstNonce);
      expect(confirmedPrefixLength).to.equal(prefixLength);
      return plan;
    },
  };
}

describe("PWA provisioning confirmed-prefix recovery", () => {
  it("strictly loads the committed public successor lineage", () => {
    const committed = loadCommittedPwaProvisioningSuccessor();
    expect(committed.originalPackageHash).to.equal("0xb307bb0656badfbeed91e9a4df500f31c85482563bb908010a85ef1f807d49bc");
    expect(committed.consumedTransactions.map((item) => item.nonce)).to.deep.equal([961n, 962n, 963n]);
    expect(committed.expectedNextNonce).to.equal(964n);
    expect(() => loadPwaProvisioningSuccessor({ ...successorValue, extra: true })).to.throw(/unknown|unexpected/i);
  });

  it("loads both committed lineages and admits an exact prefix-one successor", () => {
    const committed = loadCommittedPwaProvisioningSuccessors();
    expect(committed.map((item) => item.confirmedPrefixLength)).to.deep.equal([2, 1]);
    const prefixOne = loadPwaProvisioningSuccessor(prefixOneSuccessorValue);
    expect(prefixOne.confirmedPrefixLength).to.equal(1);
    expect(prefixOne.expectedNextNonce).to.equal(961n);
  });

  it("selects the exact prefix-one successor without weakening the older lineage", async () => {
    const nextNonce = 961n;
    const base = fixture(
      1,
      { nonce: nextNonce, mutateConsumedTransaction: (index, value) => index === 0 ? { ...value, nonce: 960 } : value },
      { nonce: nextNonce, mutateConsumedTransaction: (index, value) => index === 0 ? { ...value, nonce: 960 } : value },
      prefixOneSuccessorPlan,
    );
    const input = {
      ...base,
      successors: [loadPwaProvisioningSuccessor(successorValue), loadPwaProvisioningSuccessor(prefixOneSuccessorValue)],
      relay: evidenceClient("relay", 1, { nonce: nextNonce }, prefixOneSuccessorPlan),
      rebuildPlan: async ({ successorStartingNonce }: { successorStartingNonce?: bigint }) => successorStartingNonce === nextNonce ? prefixOneSuccessorPlan : plan,
    };
    const result = await resolvePwaProvisioningRecovery(input as never);
    expect(result?.plan).to.equal(prefixOneSuccessorPlan);
    expect(result?.confirmedPrefixLength).to.equal(1);
    expect(result?.plan.transactions.map(({ nonce }) => nonce)).to.deep.equal([959n, 961n, 962n, 963n, 964n, 965n, 966n]);
  });

  it("rebuilds a prefix-one successor after its secondary signer and prerequisites are confirmed", async () => {
    const prefixLength = 6;
    const nextNonce = 966n;
    const nonce960 = (index: number, value: Record<string, unknown>) => index === 0 ? { ...value, nonce: 960 } : value;
    const base = fixture(prefixLength, { nonce: nextNonce, mutateConsumedTransaction: nonce960 }, { nonce: nextNonce, mutateConsumedTransaction: nonce960 }, prefixOneSuccessorPlan);
    const rebuilds: Array<Readonly<{ successorStartingNonce?: bigint; verifiedDeploymentPrefixLength?: number }>> = [];
    const result = await resolvePwaProvisioningRecovery({
      ...base,
      successors: [loadPwaProvisioningSuccessor(prefixOneSuccessorValue)],
      relay: evidenceClient("relay", prefixLength, { nonce: nextNonce }, prefixOneSuccessorPlan),
      rebuildPlan: async (input: { successorStartingNonce?: bigint; verifiedDeploymentPrefixLength?: number }) => {
        rebuilds.push(input);
        return input.successorStartingNonce === 961n ? prefixOneSuccessorPlan : plan;
      },
    } as never);

    expect(result?.confirmedPrefixLength).to.equal(prefixLength);
    expect(rebuilds).to.have.length(2);
    expect(rebuilds.map((item) => item.verifiedDeploymentPrefixLength)).to.deep.equal([2, 2]);
  });

  for (const prefixLength of [1, 2, 3, 4, 5, 6]) {
    it(`recovers the exact confirmed prefix of length ${prefixLength}`, async () => {
      const input = fixture(prefixLength);
      const result = await resolvePwaProvisioningRecovery(input);
      expect(result).to.deep.equal({ plan, confirmedPrefixLength: prefixLength, credentials: { primary, secondary } });
    });
  }

  it("returns undefined only for an empty journal", async () => {
    const input = fixture(1);
    expect(await resolvePwaProvisioningRecovery({ ...input, journal: journal(0) })).to.equal(undefined);
  });

  it("keeps an original one-row recovery on its ordinary next nonce", async () => {
    const input = fixture(1);
    const result = await resolvePwaProvisioningRecovery({ ...input, successor: loadPwaProvisioningSuccessor(successorValue) });
    expect(result).to.deep.equal({ plan, confirmedPrefixLength: 1, credentials: { primary, secondary } });
  });

  it("collapses byte-identical review duplicates independent of filename", async () => {
    const input = fixture(2);
    const written = writePwaProvisioningReview(plan, input.reviewDirectory);
    copyFileSync(written.path, join(input.reviewDirectory, "arbitrary-name.json"));
    expect((await resolvePwaProvisioningRecovery(input))?.confirmedPrefixLength).to.equal(2);
  });

  it("rejects gaps, ordering drift, pending or reverted state, intent mutation, and nonce drift", async () => {
    const base = fixture(2);
    const cases: LiveJournal[] = [];
    const gap = structuredClone(base.journal); gap.entries[1]!.id = "pwa-setup-helper"; cases.push(gap);
    const order = structuredClone(base.journal); order.entries.reverse(); cases.push(order);
    const pending = structuredClone(base.journal); pending.entries[1]!.status = "pending"; pending.entries[1]!.receipt = undefined; cases.push(pending);
    const reverted = structuredClone(base.journal); reverted.entries[1]!.status = "reverted"; cases.push(reverted);
    const changedIntent = structuredClone(base.journal); changedIntent.entries[1]!.intentHash = hash(250); cases.push(changedIntent);
    const changedCost = structuredClone(base.journal); changedCost.entries[1]!.reserved -= 1n; cases.push(changedCost);
    const nonce = structuredClone(base.journal); nonce.entries[1]!.nonce += 1; cases.push(nonce);
    for (const candidate of cases) await expect(resolvePwaProvisioningRecovery({ ...base, journal: candidate })).to.be.rejected;
  });

  it("rejects provider transaction, confirmation, canonical receipt, runtime, future-code, and relay nonce drift", async () => {
    const cases = [
      fixture(2, { mutateTransaction: (index, value) => index === 0 ? { ...value, input: bytes(250) } : value }),
      fixture(2, { head: 94n }),
      fixture(2, { mutateReceipt: (index, value) => index === 0 ? { ...value, blockHash: hash(251) } : value }),
      fixture(2, { mutateRuntime: (index, value) => index === 0 ? bytes(251) : value }),
      fixture(2, { mutateRuntime: (index, value) => index === 2 ? bytes(252) : value }),
      fixture(2),
    ];
    cases[5] = { ...cases[5], relay: evidenceClient("relay", 2, { nonce: firstNonce + 3n }) };
    for (const candidate of cases) await expect(resolvePwaProvisioningRecovery(candidate)).to.be.rejected;
  });

  it("verifies consumed lineage and returns a distinct successor plan", async () => {
    const result = await resolvePwaProvisioningRecovery(successorFixture());
    expect(result?.confirmedPrefixLength).to.equal(2);
    expect(result?.plan).to.equal(successorPlan);
    expect(result?.plan.transactions.map((item) => item.nonce)).to.deep.equal([959n, 960n, 964n, 965n, 966n, 967n, 968n]);
    expect(provisioningPackageHash(result!.plan)).not.to.equal(provisioningPackageHash(plan));
  });

  for (const prefixLength of [3, 4, 5, 6, 7]) {
    it(`recovers the rebased successor after ${prefixLength - 2} suffix transaction(s) confirmed`, async () => {
      const result = await resolvePwaProvisioningRecovery(successorFixture({}, {}, prefixLength));
      expect(result?.plan).to.equal(successorPlan);
      expect(result?.confirmedPrefixLength).to.equal(prefixLength);
      expect(result?.plan.transactions[prefixLength]?.nonce ?? result!.plan.transactions.at(-1)!.nonce + 1n).to.equal(964n + BigInt(prefixLength - 2));
    });
  }

  it("rejects mutated consumed lineage and old or successor address collisions", async () => {
    const wrongSender = successorFixture({ mutateConsumedTransaction: (index, value) => index === 0 ? { ...value, from: address(250) } : value });
    const providerDisagreement = successorFixture({}, { mutateConsumedTransaction: (index, value) => index === 1 ? { ...value, input: bytes(251) } : value });
    const reverted = successorFixture({ mutateConsumedReceipt: (index, value) => index === 0 ? { ...value, status: "reverted" } : value });
    const oldCollision = successorFixture({ codeAt: transactions[2]!.expectedCreatedAddress });
    const successorCollision = successorFixture({ codeAt: successorTransactions[2]!.expectedCreatedAddress });
    const nonceSplit = successorFixture();
    nonceSplit.relay = evidenceClient("relay", 2, { nonce: firstNonce + 6n });
    for (const candidate of [wrongSender, providerDisagreement, reverted, oldCollision, successorCollision, nonceSplit]) {
      await expect(resolvePwaProvisioningRecovery(candidate as never)).to.be.rejected;
    }
  });
});
