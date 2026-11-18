import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { sha256 } from "../../scripts/plan-deployment";
import { createOrdinaryScenarioProposal } from "../../scripts/live/ordinary-scenario-executor";
import { loadHashlessSourceJournalReadOnly, verifyHashlessStateCertificate, type HashlessControlledState, type HashlessEvidenceProvider } from "../../scripts/live/ordinary-scenario-hashless-certificate";
import { attachExpiredHashlessContinuation, createExpiredHashlessContinuationProposal, loadExpiredHashlessContinuationApproval } from "../../scripts/live/ordinary-scenario-hashless-continuation";

const fixtures = join(__dirname, "../fixtures/ordinary-hashless");
const h = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const funder = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;
const safe = "0xd751a1479f49d63DC61E0081B0b4d8c60623D9a6" as Address;
const delay = "0xB8E143098CcCb9935228022173c2c987DF5FD53a" as Address;
const usdc = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
const selected = { number: 12_013_857n, hash: "0x197add23b0385bce509adab0a3f3234b58b71e63d0ebccad9aa2e99ba5f44e20" as Hex, timestamp: 1_793_209_056n };
const certified = { number: 12_013_934n, hash: "0x05d0f3b8f503bfee60455adc88c717e330aa2bafaffb6badca3b5c8215f3948e" as Hex, timestamp: 1_793_209_980n };
const current = { number: 12_013_940n, hash: h("7"), timestamp: 1_793_210_052n }; const latest = { number: 12_013_945n, hash: h("8"), timestamp: 1_793_210_112n };
const consumingHash = "0x83923abf9c1224125296a3485f8cc0a910e7f729ea5d5a73d6f01bf1cdbfe1f5" as Hex;
const controlled = (): HashlessControlledState => ({ chainId: 11155111, safe, delay, usdc, safeNonce: 7n, delayQueueNonce: 3n, delayTxNonce: 2n, queue: { queueNonce: 2n, to: funder, value: 1n, data: "0x", operation: 0, createdAt: 1_793_208_888n, expiresAt: 1_793_209_608n }, safeNativeBalance: 1n, safeUsdcBalance: 20_000_000n, funderUsdcBalance: 0n, effectiveGuardWindow: 1_793_145_600n, nativeSpend: { window: 1_793_145_600n, baseSpent: 10_000_000_000_000n, instantSpent: 30_000_000_000_000n }, usdcSpend: { window: 0n, baseSpent: 0n, instantSpent: 0n } });
const provider = (): HashlessEvidenceProvider => { const tx = { type: "legacy" as const, chainId: 11_155_111, gasPrice: 100_000n, v: 22_310_258n, hash: consumingHash, recoveredSender: funder, nonce: 809, to: "0xadb8f835e565ac7e71d2df6cfbd0fc003fa22c27" as Address, value: 0n, inputHash: "0x25491caa28455d896a7211a1c4532ab1e72412bdb15293292e2e37e5f9406c63" as Hex, gas: 1_820_162n, blockNumber: 12_013_885n, blockHash: "0x1cd3daf4cef11721feb5d564c0768f42e88d1d14c6c909e64b7cd5532b6f158b" as Hex }; return { readLatestBlock: async () => latest, readBlock: async n => n === selected.number ? selected : n === certified.number ? certified : n === current.number ? current : n === tx.blockNumber ? { number: n, hash: tx.blockHash, timestamp: 1_793_209_392n } : undefined, readTransaction: async x => x === consumingHash ? tx : undefined, readReceipt: async x => x === consumingHash ? { transactionHash: x, status: "success", blockNumber: tx.blockNumber, blockHash: tx.blockHash } : undefined, readTransactionCount: async (_address, block) => block === selected.number ? 809 : 811, readControlledState: async () => structuredClone(controlled()) }; };

export async function hashlessContinuationFixture() {
  const report = readFileSync(join(__dirname, "../fixtures/ordinary-scenario-review.public.json"), "utf8");
  const original = createOrdinaryScenarioProposal(report, { expectedPackageHash: "0x08568eb5edbd050dcd4a21eceedaff48e2d0be8b9acac54e28d024cec795e571", expectedArtifactBytesHash: "0xe72746e38c34a75d3e4fba829a085c0fa15590a6f0948b2391fa4661b568e831" });
  const journal = loadHashlessSourceJournalReadOnly(join(fixtures, "first38-live-journal-2026-10-28.json"));
  const certificate = await verifyHashlessStateCertificate(readFileSync(join(fixtures, "hashless-public-state-2026-10-28.json"), "utf8"), "0xfc9c71e506c6941496501178fc2b826575ede10839fc61fbda838bb747a8f339", journal, [provider(), provider()]);
  const observer = { kind: "https-webhook" as const, publicId: `temporary-test-receiver:${h("a")}`, endpointHash: h("a"), startupEvidenceHash: h("d"), probeEvidenceHash: h("b"), independentFromProposer: true as const, readyAt: "1793210052", workflowScheduleSeconds: { review: "3600", execution: "960", confirmations: "180", delivery: "60", acknowledgement: "300", keylessConfirmation: "300" }, requiredThrough: "1793215452", expiresAt: "1793215452" };
  const proposal = createExpiredHashlessContinuationProposal({ original, journal, certificate, observer, caps: { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" } });
  const document = { schemaVersion: 1, scope: "first38-native-ready-hashless-expired-v1", authorization: "EXPLICIT_GROUP_APPROVAL", proposalHash: proposal.proposalHash, certificateHash: proposal.certificateHash, observer: proposal.observer, caps: proposal.caps, reservation: proposal.reservation, derivations: proposal.derivations, maxBroadcastAttempts: 1, approvedActions: proposal.actions.map(({ id, commitment }) => ({ id, commitment })) };
  const approval = loadExpiredHashlessContinuationApproval(proposal, JSON.stringify(document), sha256(document) as Hex); attachExpiredHashlessContinuation(journal, proposal, approval);
  return { original, journal, proposal, approval, current, h };
}
