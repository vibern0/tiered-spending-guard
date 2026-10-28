import { expect } from "chai";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, hashTypedData, keccak256, parseTransaction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createFrozenSafeSignerProvider, createOrdinaryScenarioMechanicalExecutionContext, createOrdinaryScenarioMechanicalStateReader, loadObserverConfirmationEvidence, reconstructCanonicalType2Transaction, requireSixConfirmationReceipts, simulatePreparedOrdinaryAction, validatePublicReceiverAcknowledgement } from "../../../scripts/live/ordinary-scenario-adapter";
import { createOrdinaryScenarioJournal, createOrdinaryScenarioProposal, executeOrdinaryScenarioAction, loadOrdinaryScenarioApproval, type OrdinaryScenarioActionScope, type OrdinaryScenarioExecutionContext, type OrdinaryScenarioJournal, type OrdinaryScenarioProposal, type OrdinaryScenarioStore } from "../../../scripts/live/ordinary-scenario-executor";
import { sha256 } from "../../../scripts/plan-deployment";
import type { SafeSignerRequest } from "../../../src/signers/types";
import { ActivityLedger, FileActivityStore } from "../../../src/monitoring/ledger";

const account = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const SAFE = "0x2000000000000000000000000000000000000003" as Address;
const USDC = "0x2000000000000000000000000000000000000004" as Address;
const DELAY = "0x2000000000000000000000000000000000000005" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const types = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
  { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" },
  { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
] as const };
const message = { to: SAFE, value: 1n, data: "0x" as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: 0n };
const request: SafeSignerRequest = { chainId: 31337, safe: SAFE, safeTxHash: hashTypedData({ domain: { chainId: 31337, verifyingContract: SAFE }, types, primaryType: "SafeTx", message }), typedData: { domain: { chainId: 31337, verifyingContract: SAFE }, types, primaryType: "SafeTx", message } };

const trackedArtifact = () => readFileSync(join(__dirname, "../../fixtures/ordinary-scenario-review.public.json"), "utf8");
const bytesHash = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}` as Hex;

function trackedAuthorizedFixture(actionCount: number) {
  const serialized = trackedArtifact();
  const packageHash = sha256(JSON.parse(serialized)) as Hex;
  const proposal = createOrdinaryScenarioProposal(serialized, { expectedPackageHash: packageHash, expectedArtifactBytesHash: bytesHash(serialized) });
  const document = {
    schemaVersion: 1, scope: "bounded-ordinary-matrix-v1", authorization: "EXPLICIT_GROUP_APPROVAL", chainId: 11155111,
    proposalHash: proposal.proposalHash, reviewPackageHash: proposal.reviewPackageHash, reviewArtifactBytesHash: proposal.reviewArtifactBytesHash, planHash: proposal.planHash,
    approvedActions: proposal.actions.slice(0, actionCount).map(value => ({ id: value.id, commitment: value.commitment })),
    derivations: { outerEoaNonce: "CURRENT_ONLY", fees: "AT_OR_BELOW_ACTION_CAPS", gas: "SIGNED_SIMULATION_AT_OR_BELOW_ACTION_CAP", queueTiming: "CANONICAL_RECEIPT_CREATED_AT_ONLY", safeNonce: "FIXED", delayQueueNonce: "FIXED", delayTxNonce: "FIXED" },
    phaseLimitWei: "50000000000000000", maxBroadcastAttempts: 1,
  };
  const approval = loadOrdinaryScenarioApproval(proposal, JSON.stringify(document), { expectedProposalHash: proposal.proposalHash, expectedPackageHash: packageHash, expectedApprovalHash: sha256(document) as Hex });
  return { proposal, approval };
}

function prefixJournal(proposal: OrdinaryScenarioProposal, approval: ReturnType<typeof loadOrdinaryScenarioApproval>, actionIndex: number) {
  const journal = createOrdinaryScenarioJournal(proposal, approval, proposal.funder);
  for (const [index, action] of proposal.actions.slice(0, actionIndex).entries()) journal.actions.push({
    id: action.id, commitment: action.commitment, status: action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed",
    transactionHash: action.expectedOutcome === "rejection" ? undefined : keccak256(`0x${(index + 201).toString(16).padStart(64, "0")}` as Hex),
    evidenceHash: keccak256(`0x${(index + 1).toString(16).padStart(64, "0")}` as Hex),
    queueCreatedAt: action.kind === "queue-proposal" ? "1000" : undefined,
    establishedWindow: action.kind === "base-transfer" ? proposal.periodAnchor : undefined,
  });
  return journal;
}

class AdapterMemoryStore implements OrdinaryScenarioStore {
  constructor(public journal: OrdinaryScenarioJournal) {}
  load() { return this.journal; }
  save(value: OrdinaryScenarioJournal) { this.journal = structuredClone(value); }
}

function controlledClient(proposal: OrdinaryScenarioProposal, controlled: OrdinaryScenarioActionScope["before"], options: Readonly<{ createdAt?: bigint; wrongFingerprint?: boolean; reads?: bigint[] }> = {}) {
  const blockHash = keccak256("0x91");
  return {
    blockHash,
    client: {
      getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 1000n, baseFeePerGas: 1n }),
      getChainId: async () => 11155111,
      getTransactionCount: async () => 900,
      getBalance: async ({ address }: { address: Address }) => address.toLowerCase() === proposal.safe.toLowerCase() ? BigInt(controlled.safeNativeBalance) : 10n ** 30n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (functionName === "nonce") return BigInt(controlled.safeNonce);
        if (functionName === "queueNonce") return BigInt(controlled.delayQueueNonce);
        if (functionName === "txNonce") return BigInt(controlled.delayTxNonce);
        if (functionName === "balanceOf") return address.toLowerCase() === proposal.usdc.toLowerCase() && String(args?.[0]).toLowerCase() === proposal.safe.toLowerCase() ? BigInt(controlled.safeUsdcBalance) : BigInt(controlled.funderUsdcBalance);
        if (functionName === "spendState") return String(args?.[0]).toLowerCase() === ZERO.toLowerCase() ? [0n, BigInt(controlled.nativeBaseSpent), BigInt(controlled.nativeInstantSpent)] : [0n, BigInt(controlled.usdcBaseSpent), BigInt(controlled.usdcInstantSpent)];
        if (functionName === "getTxHash") {
          const nonce = BigInt(args?.[0] as bigint); options.reads?.push(nonce);
          const reviewed = proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce === nonce);
          return options.wrongFingerprint ? keccak256("0xff") : reviewed?.queue?.fingerprint;
        }
        if (functionName === "getTxCreatedAt") return options.createdAt ?? 1000n;
        throw new Error(`unexpected read ${functionName}`);
      },
    },
  };
}

describe("ordinary scenario frozen EIP-1193 facade", () => {
  it("selects the reviewed global Delay head from controlled state before and after queue transitions", async () => {
    const { proposal } = trackedAuthorizedFixture(38);
    const blockHash = keccak256("0x91");
    const journal = { actions: proposal.actions.map((action, index) => {
      const transactionHash = keccak256(`0x${(index + 201).toString(16).padStart(64, "0")}` as Hex);
      return { id: action.id, commitment: action.commitment, status: action.expectedOutcome === "rejection" ? "rejection-proved" : "confirmed", transactionHash: action.expectedOutcome === "rejection" ? undefined : transactionHash, evidenceHash: keccak256(`0x${(index + 1).toString(16).padStart(64, "0")}` as Hex), queueCreatedAt: action.kind === "queue-proposal" ? "1000" : undefined, receipt: action.kind === "queue-proposal" ? { transactionHash, status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 10n, blockHash } : undefined };
    }) } as unknown as OrdinaryScenarioJournal;
    const reads: bigint[] = [];
    const read = async (action: (typeof proposal.actions)[number], side: "before" | "after") => {
      const controlled = action[side];
      const { client } = controlledClient(proposal, controlled, { reads });
      const reader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 11155111, proposal, journal: () => journal, currentClient: client as never, archiveClient: client as never, observerReadiness: async () => ({ ready: true, evidenceHash: proposal.observerEvidenceHash }), verifyProfileAtBlock: async () => undefined });
      const state = await reader(action, "pre-private", side === "after" ? { actionId: action.id, transactionHash: keccak256("0x92"), blockNumber: 10n, blockHash } : undefined);
      if (controlled.queueStatus === "EMPTY") expect(state.queue, `${action.id} ${side}`).to.equal(undefined);
      else {
        const reviewed = proposal.actions.find(candidate => candidate.kind === "queue-proposal" && candidate.queue?.queueNonce.toString() === controlled.queueNonce && candidate.queue.fingerprint.toLowerCase() === controlled.queueFingerprint?.toLowerCase());
        const status = controlled.queueStatus === "QUEUED_CONDITIONAL" ? "queued" : controlled.queueStatus === "CANCELLED_CONDITIONAL" ? "cancelled" : controlled.queueStatus === "EXPIRED_CONDITIONAL" ? "expired" : "executed";
        expect(state.queue, `${action.id} ${side}`).to.deep.equal({ queueNonce: reviewed!.queue!.queueNonce, fingerprint: reviewed!.queue!.fingerprint, createdAt: 1000n, status, to: reviewed!.queue!.to, value: reviewed!.queue!.value, data: reviewed!.queue!.data, operation: reviewed!.queue!.operation });
      }
    };
    for (const action of proposal.actions) if (action.before.queueStatus !== "EMPTY") await read(action, "before");
    for (const action of proposal.actions.filter(value => value.kind === "queue-proposal")) await read(action, "after");
    expect(reads).to.include.members([0n, 1n, 2n, 3n, 4n, 5n]);

    const later = proposal.actions.find(value => value.id === "native-queue-expiry")!;
    const { client: wrong } = controlledClient(proposal, later.before, { wrongFingerprint: true });
    const wrongReader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 11155111, proposal, journal: () => journal, currentClient: wrong as never, archiveClient: wrong as never, observerReadiness: async () => ({ ready: true, evidenceHash: proposal.observerEvidenceHash }), verifyProfileAtBlock: async () => undefined });
    await expect(wrongReader(later, "pre-private")).to.be.rejectedWith("fingerprint mismatch");
  });

  it("rejects an adapter-read prior head with the wrong canonical createdAt before materialization", async () => {
    const tracked = trackedAuthorizedFixture(38);
    const actionIndex = tracked.proposal.actions.findIndex(value => value.id === "native-queue-expiry");
    const action = tracked.proposal.actions[actionIndex]!;
    const scoped = trackedAuthorizedFixture(actionIndex + 1);
    const journal = prefixJournal(scoped.proposal, scoped.approval, actionIndex);
    const store = new AdapterMemoryStore(journal);
    const { client } = controlledClient(scoped.proposal, action.before, { createdAt: 999n });
    const reader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 11155111, proposal: scoped.proposal, journal: () => store.load(), currentClient: client as never, archiveClient: client as never, observerReadiness: async () => ({ ready: true, evidenceHash: scoped.proposal.observerEvidenceHash }), verifyProfileAtBlock: async () => undefined });
    let materialized = false;
    const context = { readState: reader, materialize: async () => { materialized = true; throw new Error("must not materialize"); } } as unknown as OrdinaryScenarioExecutionContext;
    await expect(executeOrdinaryScenarioAction(scoped.proposal, scoped.approval, store, context)).to.be.rejectedWith("queue createdAt is not bound to proposal receipt");
    expect(materialized).to.equal(false);
  });

  it("fails closed when controlled queue nonce or fingerprint has no reviewed head", async () => {
    const { proposal } = trackedAuthorizedFixture(38);
    const action = proposal.actions.find(value => value.id === "native-queue-expiry")!;
    const journal = { actions: [] } as unknown as OrdinaryScenarioJournal;
    for (const before of [
      { ...action.before, queueNonce: "999" },
      { ...action.before, queueFingerprint: keccak256("0xee") },
    ]) {
      const clonedAction = { ...action, before };
      const { client } = controlledClient(proposal, before);
      const reader = createOrdinaryScenarioMechanicalStateReader({ expectedChainId: 11155111, proposal, journal: () => journal, currentClient: client as never, archiveClient: client as never, observerReadiness: async () => ({ ready: true, evidenceHash: proposal.observerEvidenceHash }), verifyProfileAtBlock: async () => undefined });
      await expect(reader(clonedAction, "pre-private")).to.be.rejectedWith("reviewed controlled queue head is missing or ambiguous");
    }
    const duplicate = JSON.parse(trackedArtifact()) as { actions: Array<{ id: string; queue?: { queueNonce: string } }> };
    duplicate.actions.find(value => value.id === "native-queue-expiry")!.queue!.queueNonce = "0";
    const serialized = JSON.stringify(duplicate);
    expect(() => createOrdinaryScenarioProposal(serialized, { expectedPackageHash: sha256(duplicate) as Hex, expectedArtifactBytesHash: bytesHash(serialized) })).to.throw("fixed Delay queue nonce mismatch");
  });

  it("exposes only the frozen chain, account, and exact typed-data request", async () => {
    let calls = 0;
    const provider = createFrozenSafeSignerProvider({ account: account.address, request, signTypedData: async value => { calls++; return account.signTypedData(value.typedData as never); } });
    expect(await provider.request({ method: "eth_chainId" })).to.equal("0x7a69");
    expect(await provider.request({ method: "eth_accounts" })).to.deep.equal([account.address]);
    const payload = JSON.stringify(request.typedData, (_, value) => typeof value === "bigint" ? value.toString() : value);
    expect(await provider.request({ method: "eth_signTypedData_v4", params: [account.address, payload] })).to.match(/^0x[0-9a-f]{130}$/);
    expect(calls).to.equal(1);
    await expect(provider.request({ method: "eth_signTypedData_v4", params: [SAFE, payload] })).to.be.rejectedWith("frozen");
    await expect(provider.request({ method: "eth_signTypedData_v4", params: [account.address, payload.replace('"nonce":"0"', '"nonce":"1"')] })).to.be.rejectedWith("frozen");
    await expect(provider.request({ method: "personal_sign", params: ["0x12", account.address] })).to.be.rejectedWith("unsupported");
    await expect(provider.request({ method: "eth_sendTransaction", params: [] })).to.be.rejectedWith("unsupported");
    expect(calls).to.equal(1);
  });

  it("withholds receipts until six confirmations and detects a changed canonical block", async () => {
    const receipt = { transactionHash: keccak256("0x01"), status: "success" as const, gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 10n, blockHash: keccak256("0x02") };
    let head = 14n;
    const live = requireSixConfirmationReceipts({ funder: account.address, chainId: async () => 11155111, nonce: async () => 0, balance: async () => 1n, sign: async () => "0x" as Hex, broadcast: async () => receipt.transactionHash, receipt: async () => receipt }, { blockNumber: async () => head, blockHash: async () => receipt.blockHash });
    expect(await live.receipt(receipt.transactionHash)).to.equal(undefined);
    head = 15n;
    expect(await live.receipt(receipt.transactionHash)).to.deep.equal(receipt);
    let reads = 0;
    const changed = requireSixConfirmationReceipts({ ...live, receipt: async () => receipt }, { blockNumber: async () => 15n, blockHash: async () => ++reads === 1 ? receipt.blockHash : keccak256("0xff") });
    await expect(changed.receipt(receipt.transactionHash)).to.be.rejectedWith("changed");
  });

  it("simulates the exact signed outer tuple at one rechecked block", async () => {
    const blockHash = keccak256("0x03");
    const prepared = { liveIntent: { id: "x", to: SAFE, data: "0x1234" as Hex, value: 0n, nonce: 1, gas: 100n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, requestHash: keccak256("0x04"), signerRolesHash: keccak256("0x05"), signedCalldataHash: keccak256("0x1234"), signatureBundleHash: null, transientSignedCalldata: "0x1234" as Hex };
    const seen: unknown[] = [];
    const evidence = await simulatePreparedOrdinaryAction({ blockHash: async () => blockHash, call: async input => { seen.push(input); return encodeAbiParameters([{ type: "bool" }], [true]); }, estimateGas: async input => { seen.push(input); return 99n; } }, account.address, prepared, 7n, blockHash, 100n, "bool-true");
    expect(evidence).to.include({ gasEstimate: 99n, blockNumber: 7n, blockHash });
    expect(seen).to.have.length(2);
    await expect(simulatePreparedOrdinaryAction({ blockHash: async () => blockHash, call: async () => encodeAbiParameters([{ type: "bool" }], [true]), estimateGas: async () => 101n }, account.address, prepared, 7n, blockHash, 100n, "bool-true")).to.be.rejectedWith("cap");
    await expect(simulatePreparedOrdinaryAction({ blockHash: async () => blockHash, call: async () => encodeAbiParameters([{ type: "bool" }], [false]), estimateGas: async () => 99n }, account.address, prepared, 7n, blockHash, 100n, "bool-true")).to.be.rejectedWith("result");
    await expect(simulatePreparedOrdinaryAction({ blockHash: async () => blockHash, call: async () => "0x01", estimateGas: async () => 99n }, account.address, prepared, 7n, blockHash, 100n, "empty")).to.be.rejectedWith("result");
    expect((await simulatePreparedOrdinaryAction({ blockHash: async () => blockHash, call: async () => "0x", estimateGas: async () => 99n }, account.address, prepared, 7n, blockHash, 100n, "empty")).success).to.equal(true);
  });

  it("selects the simulation result contract from the reviewed transaction shape", async () => {
    const blockHash = keccak256("0x0a");
    const trueResult = encodeAbiParameters([{ type: "bool" }], [true]);
    const currentClient = {
      getBlock: async () => ({ hash: blockHash }),
      estimateGas: async () => 99n,
      call: async ({ to, data }: { to: Address; data: Hex }) => to.toLowerCase() === USDC.toLowerCase() || (to.toLowerCase() === SAFE.toLowerCase() && data !== "0x") ? { data: trueResult } : { data: "0x" },
    };
    const context = createOrdinaryScenarioMechanicalExecutionContext({ expectedChainId: 31337, proposal: { safe: SAFE, usdc: USDC, funder: account.address }, currentClient, archiveClient: {}, loadSigners: async () => { throw new Error("unused"); } } as never, (async () => { throw new Error("unused"); }) as never);
    const state = { blockNumber: 7n, blockHash } as never;
    const prepared = (id: string, to: Address, data: Hex) => ({ liveIntent: { id, to, data, value: 0n, nonce: 1, gas: 100n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, requestHash: keccak256("0x04"), signerRolesHash: keccak256("0x05"), signedCalldataHash: keccak256(data), signatureBundleHash: null, transientSignedCalldata: data });
    const cases = [
      [{ id: "native-funding", gasLimitCap: 100n, publicTransaction: { to: SAFE, value: 1n, data: "0x" } }, prepared("native-funding", SAFE, "0x")],
      [{ id: "usdc-funding", gasLimitCap: 100n, publicTransaction: { to: USDC, value: 0n, data: "0xa9059cbb00" } }, prepared("usdc-funding", USDC, "0xa9059cbb00")],
      [{ id: "safe-execution", gasLimitCap: 100n, safeTransaction: {} }, prepared("safe-execution", SAFE, "0x1234")],
      [{ id: "delay-execution", gasLimitCap: 100n, publicTransaction: { to: DELAY, value: 0n, data: "0x1234" } }, prepared("delay-execution", DELAY, "0x1234")],
    ] as const;
    for (const [action, value] of cases) expect((await context.simulate(action as never, value as never, state)).success).to.equal(true);
    expect(() => context.simulate({ id: "unknown-token-call", gasLimitCap: 100n, publicTransaction: { to: USDC, value: 0n, data: "0x095ea7b3" } } as never, prepared("unknown-token-call", USDC, "0x095ea7b3") as never, state)).to.throw("not transfer");
  });

  it("keeps timely historical acknowledgement valid after expiry but rejects late capture", () => {
    const endpointHash = "0x8a3e2db19f160da76a08385670e22e08a293ee5b09276b90e74cd2dc65029ae0" as Hex;
    const transactionHash = keccak256("0x06"); const payloadSha256 = keccak256("0x07");
    const receipt = { schemaVersion: 1 as const, endpointHash, transactionHash, payloadSha256, receiverRequestId: "request-1", receiverRecordedAt: "2026-10-27T12:00:00Z", retrievedAt: "2026-10-27T12:01:00Z", retrievalProvenance: "official-receiver-api" as const, expiresAt: "2026-10-28T18:51:57Z" };
    expect(validatePublicReceiverAcknowledgement(receipt, { endpointHash, transactionHash, payloadSha256, now: new Date("2026-10-27T13:00:00Z") })).to.match(/^0x[0-9a-f]{64}$/);
    expect(validatePublicReceiverAcknowledgement(receipt, { endpointHash, transactionHash, payloadSha256, now: new Date("2026-10-28T18:51:58Z") })).to.match(/^0x[0-9a-f]{64}$/);
    expect(() => validatePublicReceiverAcknowledgement({ ...receipt, retrievedAt: "2026-10-28T18:51:58Z" }, { endpointHash, transactionHash, payloadSha256, now: new Date("2026-10-28T18:51:58Z") })).to.throw("timely");
  });

  it("requires delivered ledger evidence after a real restart and a matching receiver acknowledgement", () => {
    const directory = mkdtempSync(join(tmpdir(), "ordinary-observer-")); const ledgerPath = join(directory, "ledger.json"); const acknowledgementPath = join(directory, "ack.json");
    const endpointHash = "0x8a3e2db19f160da76a08385670e22e08a293ee5b09276b90e74cd2dc65029ae0" as Hex; const transactionHash = keccak256("0x08"); const blockHash = keccak256("0x09");
    const alert = { kind: "delayed-cancelled" as const, chainId: 11155111, safe: SAFE, transactionHash, blockNumber: 10n, logIndex: 0, delay: SAFE, cancelledThrough: 1n };
    const key = { chainId: 11155111, transactionHash, blockHash, logIndex: 0 };
    try {
      const firstStore = new FileActivityStore(ledgerPath); const first = new ActivityLedger(firstStore); first.accept(key, alert); const payloadSha256 = first.payloadHash(alert); firstStore.close();
      writeFileSync(acknowledgementPath, JSON.stringify({ schemaVersion: 1, endpointHash, transactionHash, payloadSha256, receiverRequestId: "request-2", receiverRecordedAt: "2026-10-27T12:00:00Z", retrievedAt: "2026-10-27T12:01:00Z", retrievalProvenance: "official-receiver-api", expiresAt: "2026-10-28T18:51:57Z" }));
      expect(() => loadObserverConfirmationEvidence({ ledgerPath, acknowledgementPath, endpointHash, transactionHash, now: new Date("2026-10-27T13:00:00Z") })).to.throw("pending");
      const secondStore = new FileActivityStore(ledgerPath); const second = new ActivityLedger(secondStore); second.markDelivered(key, { channel: "webhook", httpStatus: 200, payloadHash: payloadSha256, deliveredAt: "2026-10-27T12:00:30Z" }); secondStore.close();
      expect(loadObserverConfirmationEvidence({ ledgerPath, acknowledgementPath, endpointHash, transactionHash, now: new Date("2026-10-27T13:00:00Z") })).to.match(/^0x[0-9a-f]{64}$/);
      expect(() => loadObserverConfirmationEvidence({ ledgerPath, acknowledgementPath, endpointHash, transactionHash, expected: { kind: "delayed-queued", safe: SAFE, delay: SAFE, blockNumber: 10n, queueNonce: 1n }, now: new Date("2026-10-27T13:00:00Z") })).to.throw("canonical effect");
      expect(loadObserverConfirmationEvidence({ ledgerPath, acknowledgementPath, endpointHash, transactionHash, expected: { kind: "delayed-cancelled", safe: SAFE, delay: SAFE, blockNumber: 10n, cancelledThrough: 1n }, now: new Date("2026-10-27T13:00:00Z") })).to.match(/^0x[0-9a-f]{64}$/);
      const wrong = JSON.parse(readFileSync(acknowledgementPath, "utf8")); wrong.payloadSha256 = keccak256("0xaa"); writeFileSync(acknowledgementPath, JSON.stringify(wrong));
      expect(() => loadObserverConfirmationEvidence({ ledgerPath, acknowledgementPath, endpointHash, transactionHash, now: new Date("2026-10-27T13:00:00Z") })).to.throw("binding");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reconstructs the exact original type-2 replay envelope without invoking a signer", async () => {
    let signerCalls = 0;
    const raw = await account.signTransaction({ type: "eip1559", chainId: 11155111, nonce: 7, gas: 21_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1n, to: SAFE, value: 2n, data: "0x", accessList: [] });
    const parsed = parseTransaction(raw);
    const reconstructed = reconstructCanonicalType2Transaction({ chainId: 11155111, nonce: 7, gas: 21_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1n, to: SAFE, value: 2n, data: "0x", accessList: [], r: parsed.r!, s: parsed.s!, yParity: parsed.yParity! as 0 | 1, hash: keccak256(raw) });
    expect(reconstructed).to.equal(raw);
    expect(signerCalls).to.equal(0);
  });
});
