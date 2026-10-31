import { encodeFunctionData, hashTypedData, type Address, type Hex } from "viem";
import { buildExecutionTransaction, buildQueueTransaction, queueFingerprint, queueMonitoringFingerprint, type DelayQueueItem } from "../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { sha256 } from "../plan-deployment";
import type { OrdinaryScenarioActionRecord } from "./ordinary-scenario-executor";
import type { ContinuationObserverBinding, ExpiredHashlessContinuationAction } from "./ordinary-scenario-hashless-continuation";
import {
  USDC_DELAYED_SUCCESSOR_SCOPE,
  isVerifiedUsdcDelayedSuccessorCertificate,
  isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly,
  usdcDelayedSuccessorPredecessorValue,
  type UsdcDelayedSuccessorSource,
  type VerifiedUsdcDelayedSuccessorCertificate,
} from "./ordinary-scenario-usdc-delayed-successor-certificate";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PHASE_LIMIT = 50_000_000_000_000_000n;
const PRIOR_APPROVED_MAXIMUM = 140_501_418_272_986n;
const RESERVATION = 2_600_000_000_000n;
const USDC_AMOUNT = 31_000_000n;
const TOKEN_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const DELAY_ABI = [{ type: "function", name: "skipExpired", stateMutability: "nonpayable", inputs: [] }] as const;

export const DELAYED_SUCCESSOR_AUTHORITY_EVIDENCE_HASH = sha256({ scope: USDC_DELAYED_SUCCESSOR_SCOPE, userAuthority: "focused-delayed-successor-approved-2026-10-31", newGrossUsdc: "31000000", aggregateGrossUsdc: "51000000", inwardUsdc: "0", repairAuthority: "NONE" }) as Hex;
export const DELAYED_SUCCESSOR_SCHEDULE = Object.freeze({ review: "300", execution: "600", confirmations: "180", delivery: "60", acknowledgement: "180", keylessConfirmation: "180", reviewAdmission: "1800", initialExecutionAdmission: "1500", reconciliationMargin: "300" } as const);
export const DELAYED_SUCCESSOR_GROUPS = Object.freeze([
  Object.freeze({ start: 1 as const, end: 2 as const, budgetSeconds: "300" as const }),
  Object.freeze({ start: 3 as const, end: 5 as const, budgetSeconds: "600" as const }),
]);

const IDS = Object.freeze(["skip-expired", "expired-execution-rejection", "queue-execute", "queue-execute-early-rejection", "queue-ready-execute"].map(id => `usdc-delayed-successor-${id}`));
const DEPENDENCIES = Object.freeze([
  Object.freeze(["usdc-delayed-completion-queue-expiry"]),
  Object.freeze([IDS[0]!]),
  Object.freeze([IDS[1]!]),
  Object.freeze([IDS[2]!]),
  Object.freeze([IDS[3]!]),
]);

export type UsdcDelayedSuccessorCaps = Readonly<{ safeExecutionGasLimit: "2000000"; publicDelayGasLimit: "300000"; maxFeePerGas: "1000000"; maxPriorityFeePerGas: "1000000" }>;
export type UsdcDelayedSuccessorCodeBinding = Readonly<{ head: Hex; tree: Hex; logHash: Hex }>;
type Schedule = typeof DELAYED_SUCCESSOR_SCHEDULE;
type Group = typeof DELAYED_SUCCESSOR_GROUPS[number];
type Reservation = Readonly<{ phaseLimitWei: string; priorApprovedMaximumCumulativeOutlayWei: string; successorMaximumReservationWei: string; additionalPhaseReservationWei: "0"; maximumCumulativeOutlayWei: string; newGrossUsdcAllowance: "31000000"; aggregateGrossUsdcAllowance: "51000000"; inwardUsdcFunding: "0" }>;
declare const proposalBrand: unique symbol;
export type UsdcDelayedSuccessorProposal = Readonly<{ schemaVersion: 1; scope: typeof USDC_DELAYED_SUCCESSOR_SCOPE; authorization: "NONE"; chainId: 11155111; authorityEvidenceHash: Hex; sourceJournalHash: Hex; certificateHash: Hex; codeBinding: UsdcDelayedSuccessorCodeBinding; snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string }>; minimumOuterNonce: number; effectivePeriod: string; deadline: string; observer: ContinuationObserverBinding; schedule: Schedule; groups: readonly Group[]; caps: UsdcDelayedSuccessorCaps; reservation: Reservation; maxBroadcastAttempts: 1; repairAuthority: "NONE"; actions: readonly ExpiredHashlessContinuationAction[]; proposalHash: Hex; readonly [proposalBrand]: true }>;
declare const approvalBrand: unique symbol;
export type UsdcDelayedSuccessorApproval = Readonly<{ approvalHash: Hex; readonly [approvalBrand]: true }>;
export type UsdcDelayedSuccessorStorage = Readonly<{ schemaVersion: 1; scope: typeof USDC_DELAYED_SUCCESSOR_SCOPE; sourceJournalHash: Hex; certificateHash: Hex; proposalHash: Hex; approvalHash: Hex; minimumOuterNonce: number; effectivePeriod: string; deadline: string; actionCommitments: readonly Readonly<{ id: string; commitment: Hex }>[]; maximumReservationWei: string; maxBroadcastAttempts: 1; repairAuthority: "NONE"; actions: Array<Readonly<{ id: string; commitment: Hex; status: "approved" }> | OrdinaryScenarioActionRecord> }>;

const productionProposals = new WeakSet<object>();
const testProposals = new WeakSet<object>();
const productionApprovals = new WeakMap<object, UsdcDelayedSuccessorProposal>();
const testApprovals = new WeakMap<object, UsdcDelayedSuccessorProposal>();
const publicApprovals = new WeakMap<object, Readonly<Record<string, unknown>>>();
const proposalJournals = new WeakMap<object, UsdcDelayedSuccessorSource["journal"]>();
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const publicValue = (value: unknown): unknown => typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(publicValue) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, publicValue(child)])) : value;
const publicHash = (value: unknown): Hex => sha256(publicValue(value)) as Hex;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const decimal = (value: unknown, label: string): bigint => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };
const validateCodeBinding = (value: UsdcDelayedSuccessorCodeBinding): UsdcDelayedSuccessorCodeBinding => { exactKeys(value as unknown as Record<string, unknown>, ["head", "tree", "logHash"], "delayed successor code binding"); if (![value.head, value.tree, value.logHash].every(item => HASH.test(item))) throw new Error("delayed successor code binding is malformed"); return freeze({ ...value }); };

function validateCaps(caps: UsdcDelayedSuccessorCaps): UsdcDelayedSuccessorCaps {
  const expected = { safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
  if (JSON.stringify(caps) !== JSON.stringify(expected)) throw new Error("delayed successor caps must equal reviewed literals");
  return freeze({ ...caps });
}

function validateObserver(observer: ContinuationObserverBinding, certificate: VerifiedUsdcDelayedSuccessorCertificate, deadline: bigint, source: UsdcDelayedSuccessorSource): ContinuationObserverBinding {
  exactKeys(observer as unknown as Record<string, unknown>, ["kind", "publicId", "endpointHash", "startupEvidenceHash", "probeEvidenceHash", "independentFromProposer", "readyAt", "workflowScheduleSeconds", "requiredThrough", "expiresAt"], "delayed successor observer");
  const workflow = { review: "300", execution: "600", confirmations: "180", delivery: "60", acknowledgement: "180", keylessConfirmation: "180" };
  if (observer.kind !== "https-webhook" || observer.independentFromProposer !== true || JSON.stringify(observer.workflowScheduleSeconds) !== JSON.stringify(workflow) || !observer.publicId.startsWith("temporary-test-receiver:") || !observer.publicId.endsWith(observer.endpointHash) || !HASH.test(observer.endpointHash) || !HASH.test(observer.startupEvidenceHash) || !HASH.test(observer.probeEvidenceHash)) throw new Error("delayed successor observer or workflow is invalid");
  const prior = source.delayedProposal.observer;
  if ([observer.endpointHash, observer.startupEvidenceHash, observer.probeEvidenceHash].some(value => [prior.endpointHash, prior.startupEvidenceHash, prior.probeEvidenceHash].some(old => same(value, old)))) throw new Error("delayed successor observer must be fresh");
  const ready = decimal(observer.readyAt, "observer readyAt"), required = decimal(observer.requiredThrough, "observer requiredThrough"), expires = decimal(observer.expiresAt, "observer expiresAt");
  if (ready < BigInt(certificate.snapshot.timestamp) || required !== ready + 1_800n || deadline - ready < 1_800n || expires < required) throw new Error("delayed successor observer lacks 1800-second coverage");
  return freeze({ ...observer, workflowScheduleSeconds: { ...observer.workflowScheduleSeconds } });
}

type State = ExpiredHashlessContinuationAction["before"];
const state = (certificate: VerifiedUsdcDelayedSuccessorCertificate, safeNonce: number, queueNonce: number, txNonce: number, safeUsdc: number, funderUsdc: number, queueStatus: State["queueStatus"], activeQueue: number, fingerprint: Hex): State => freeze({
  safeNonce: String(safeNonce), delayQueueNonce: String(queueNonce), delayTxNonce: String(txNonce), safeNativeBalance: "0", safeUsdcBalance: String(safeUsdc), funderUsdcBalance: String(funderUsdc),
  nativeBaseSpent: certificate.rawNativeSpend.baseSpent.toString(), nativeInstantSpent: certificate.rawNativeSpend.instantSpent.toString(), usdcBaseSpent: certificate.rawUsdcSpend.baseSpent.toString(), usdcInstantSpent: certificate.rawUsdcSpend.instantSpent.toString(),
  queueStatus, queueNonce: String(activeQueue), queueFingerprint: fingerprint,
});
const action = (value: Omit<ExpiredHashlessContinuationAction, "commitment">): ExpiredHashlessContinuationAction => freeze({ ...value, commitment: publicHash(value) });

function safeTransaction(source: UsdcDelayedSuccessorSource, to: Address, data: Hex, nonce: number) {
  const tx = freeze({ to, value: "0", data, operation: 0 as const, safeTxGas: "0" as const, baseGas: "0" as const, gasPrice: "0" as const, gasToken: ZERO, refundReceiver: ZERO, nonce: String(nonce) });
  const safeTxHash = hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: source.prior.historical.prior.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...tx, value: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(nonce) } });
  return { tx, safeTxHash };
}

function buildActions(source: UsdcDelayedSuccessorSource, certificate: VerifiedUsdcDelayedSuccessorCertificate, caps: UsdcDelayedSuccessorCaps): readonly ExpiredHashlessContinuationAction[] {
  const identity = source.prior.historical.prior.original;
  const transfer = encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [identity.recipient, USDC_AMOUNT] });
  const existing = source.delayedProposal.actions[6]!.queue!;
  const q5: DelayQueueItem = { safe: identity.safe, delay: identity.delay, to: existing.to, value: BigInt(existing.value), data: existing.data, operation: 0, queueNonce: 5n };
  if (!same(queueFingerprint(q5), certificate.activeQueue.fingerprint)) throw new Error("delayed successor active queue fingerprint changed");
  const q6: DelayQueueItem = { safe: identity.safe, delay: identity.delay, to: identity.usdc, value: 0n, data: transfer, operation: 0, queueNonce: 6n };
  const q6binding = freeze({ queueNonce: "6", fingerprint: queueFingerprint(q6), monitoringFingerprint: queueMonitoringFingerprint(q6), to: q6.to, value: "0", data: q6.data, operation: 0 as const });
  const q5binding = freeze({ queueNonce: "5", fingerprint: queueFingerprint(q5), monitoringFingerprint: queueMonitoringFingerprint(q5), to: q5.to, value: "0", data: q5.data, operation: 0 as const });
  const skip = { to: identity.delay, value: 0n, data: encodeFunctionData({ abi: DELAY_ABI, functionName: "skipExpired" }) };
  const execute5 = buildExecutionTransaction(q5), queue6tx = buildQueueTransaction(q6), execute6 = buildExecutionTransaction(q6), safeQueue6 = safeTransaction(source, queue6tx.to, queue6tx.data, 13);
  const s0 = state(certificate, 13, 6, 5, 31_000_000, 9_000_000, "QUEUED", 5, q5binding.fingerprint);
  const s1 = state(certificate, 13, 6, 6, 31_000_000, 9_000_000, "EXPIRED_CONDITIONAL", 5, q5binding.fingerprint);
  const s2 = state(certificate, 14, 7, 6, 31_000_000, 9_000_000, "QUEUED", 6, q6binding.fingerprint);
  const s3 = state(certificate, 14, 7, 7, 0, 40_000_000, "EXECUTED", 6, q6binding.fingerprint);
  const common = (index: number, kind: string, expectedOutcome: "success" | "rejection", signerRoles: readonly string[], transaction: { to: Address; value: bigint; data: Hex }, before: State, after: State, gasLimitCap: string, safe?: ReturnType<typeof safeTransaction>, binding?: typeof q5binding) => action({ id: IDS[index]!, kind, asset: "USDC", expectedOutcome, signerRoles: freeze([...signerRoles]), dependsOn: DEPENDENCIES[index]!, transaction: freeze({ to: transaction.to, value: transaction.value.toString(), data: transaction.data, operation: 0 as const }), safeTransaction: safe?.tx, safeTxHash: safe?.safeTxHash, queue: binding, before, after, gasLimitCap, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas });
  return freeze([
    common(0, "queue-expiry", "success", [], skip, s0, s1, caps.publicDelayGasLimit, undefined, q5binding),
    common(1, "expected-expired-rejection", "rejection", [], execute5, s1, s1, caps.publicDelayGasLimit, undefined, q5binding),
    common(2, "queue-proposal", "success", ["primary-passkey", "safe-contract-secondary"], queue6tx, s1, s2, caps.safeExecutionGasLimit, safeQueue6, q6binding),
    common(3, "expected-early-rejection", "rejection", [], execute6, s2, s2, caps.publicDelayGasLimit, undefined, q6binding),
    common(4, "ready-delay-execution", "success", [], execute6, s2, s3, caps.publicDelayGasLimit, undefined, q6binding),
  ]);
}

type ProposalInput = Readonly<{ source: UsdcDelayedSuccessorSource; certificate: VerifiedUsdcDelayedSuccessorCertificate; observer: ContinuationObserverBinding; caps: UsdcDelayedSuccessorCaps; codeBinding: UsdcDelayedSuccessorCodeBinding }>;
function buildProposal(input: ProposalInput, testOnly: boolean): UsdcDelayedSuccessorProposal {
  const verified = testOnly ? isVerifiedUsdcDelayedSuccessorCertificateForTestsOnly(input.certificate) : isVerifiedUsdcDelayedSuccessorCertificate(input.certificate);
  if (!verified || !same(input.source.sourceJournalHash, input.certificate.sourceJournalHash) || !same(publicHash(usdcDelayedSuccessorPredecessorValue(input.source.journal)), input.source.sourceJournalHash)) throw new Error("delayed successor source and opaque certificate are not exactly bound");
  const effectivePeriod = input.certificate.effectivePeriod, deadline = effectivePeriod + 86_400n, caps = validateCaps(input.caps), codeBinding = validateCodeBinding(input.codeBinding), observer = validateObserver(input.observer, input.certificate, deadline, input.source), actions = buildActions(input.source, input.certificate, caps);
  const reservation = actions.filter(item => item.expectedOutcome === "success").reduce((sum, item) => sum + BigInt(item.gasLimitCap) * BigInt(item.maxFeePerGasCap), 0n);
  if (actions.length !== 5 || reservation !== RESERVATION || PRIOR_APPROVED_MAXIMUM > PHASE_LIMIT) throw new Error("delayed successor exact five-row reservation mismatch");
  const reservationValue = freeze({ phaseLimitWei: PHASE_LIMIT.toString(), priorApprovedMaximumCumulativeOutlayWei: PRIOR_APPROVED_MAXIMUM.toString(), successorMaximumReservationWei: reservation.toString(), additionalPhaseReservationWei: "0" as const, maximumCumulativeOutlayWei: PRIOR_APPROVED_MAXIMUM.toString(), newGrossUsdcAllowance: "31000000" as const, aggregateGrossUsdcAllowance: "51000000" as const, inwardUsdcFunding: "0" as const });
  const body = { schemaVersion: 1 as const, scope: USDC_DELAYED_SUCCESSOR_SCOPE, authorization: "NONE" as const, chainId: 11_155_111 as const, authorityEvidenceHash: DELAYED_SUCCESSOR_AUTHORITY_EVIDENCE_HASH, sourceJournalHash: input.source.sourceJournalHash, certificateHash: input.certificate.certificateHash, codeBinding, snapshot: freeze({ blockNumber: input.certificate.snapshot.blockNumber, blockHash: input.certificate.snapshot.blockHash, timestamp: input.certificate.snapshot.timestamp }), minimumOuterNonce: input.certificate.minimumOuterNonce, effectivePeriod: effectivePeriod.toString(), deadline: deadline.toString(), observer, schedule: DELAYED_SUCCESSOR_SCHEDULE, groups: DELAYED_SUCCESSOR_GROUPS, caps, reservation: reservationValue, maxBroadcastAttempts: 1 as const, repairAuthority: "NONE" as const, actions };
  const proposal = freeze({ ...body, proposalHash: publicHash(body) }) as unknown as UsdcDelayedSuccessorProposal;
  (testOnly ? testProposals : productionProposals).add(proposal); proposalJournals.set(proposal, input.source.journal);
  return proposal;
}

export function createUsdcDelayedSuccessorProposal(input: ProposalInput): UsdcDelayedSuccessorProposal { return buildProposal(input, false); }
export function createUsdcDelayedSuccessorProposalForTestsOnly(input: ProposalInput): UsdcDelayedSuccessorProposal { return buildProposal(input, true); }
export function parseUsdcDelayedSuccessorProposal(serialized: string, source: UsdcDelayedSuccessorSource, certificate: VerifiedUsdcDelayedSuccessorCertificate, codeBinding: UsdcDelayedSuccessorCodeBinding): UsdcDelayedSuccessorProposal { let parsed: any; try { parsed = JSON.parse(serialized); } catch { throw new Error("delayed successor proposal must be JSON"); } const expected = buildProposal({ source, certificate, observer: parsed?.observer, caps: parsed?.caps, codeBinding }, false); if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("delayed successor proposal shape, catalog, code binding, or hash drift"); return expected; }
export function parseUsdcDelayedSuccessorProposalForTestsOnly(serialized: string, source: UsdcDelayedSuccessorSource, certificate: VerifiedUsdcDelayedSuccessorCertificate, codeBinding: UsdcDelayedSuccessorCodeBinding): UsdcDelayedSuccessorProposal { let parsed: any; try { parsed = JSON.parse(serialized); } catch { throw new Error("delayed successor proposal must be JSON"); } const expected = buildProposal({ source, certificate, observer: parsed?.observer, caps: parsed?.caps, codeBinding }, true); if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("delayed successor proposal shape, catalog, code binding, or hash drift"); return expected; }

function loadApproval(proposal: UsdcDelayedSuccessorProposal, serialized: string, expectedHash: Hex, proposals: WeakSet<object>, approvals: WeakMap<object, UsdcDelayedSuccessorProposal>): UsdcDelayedSuccessorApproval {
  if (!proposals.has(proposal)) throw new Error("delayed successor proposal is not opaque for this authority");
  let value: any; try { value = JSON.parse(serialized); } catch { throw new Error("delayed successor approval must be JSON"); }
  const approvalHash = publicHash(value);
  if (!same(approvalHash, expectedHash)) throw new Error("delayed successor approval hash mismatch");
  exactKeys(value, ["schemaVersion", "scope", "authorization", "authorityEvidenceHash", "proposalHash", "sourceJournalHash", "certificateHash", "codeBinding", "snapshot", "minimumOuterNonce", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "maxBroadcastAttempts", "repairAuthority", "approvedActions"], "delayed successor approval");
  if (value.schemaVersion !== 1 || value.scope !== proposal.scope || value.authorization !== "FOCUSED_BOUNDED_DELAYED_SUCCESSOR_AUTHORIZATION" || value.authorityEvidenceHash !== proposal.authorityEvidenceHash || value.proposalHash !== proposal.proposalHash || value.sourceJournalHash !== proposal.sourceJournalHash || value.certificateHash !== proposal.certificateHash || value.minimumOuterNonce !== proposal.minimumOuterNonce || value.effectivePeriod !== proposal.effectivePeriod || value.deadline !== proposal.deadline || value.maxBroadcastAttempts !== 1 || value.repairAuthority !== "NONE" || JSON.stringify(value.codeBinding) !== JSON.stringify(proposal.codeBinding) || JSON.stringify(value.snapshot) !== JSON.stringify(proposal.snapshot) || JSON.stringify(value.observer) !== JSON.stringify(proposal.observer) || JSON.stringify(value.schedule) !== JSON.stringify(proposal.schedule) || JSON.stringify(value.groups) !== JSON.stringify(proposal.groups) || JSON.stringify(value.caps) !== JSON.stringify(proposal.caps) || JSON.stringify(value.reservation) !== JSON.stringify(proposal.reservation)) throw new Error("delayed successor approval binding mismatch");
  if (!Array.isArray(value.approvedActions) || value.approvedActions.length !== 5 || value.approvedActions.some((item: any, index: number) => item.id !== proposal.actions[index]!.id || item.commitment !== proposal.actions[index]!.commitment)) throw new Error("delayed successor approved action mismatch");
  const approval = freeze({ approvalHash }) as UsdcDelayedSuccessorApproval; approvals.set(approval, proposal); publicApprovals.set(approval, freeze(structuredClone(value))); return approval;
}
export function loadUsdcDelayedSuccessorApproval(proposal: UsdcDelayedSuccessorProposal, serialized: string, expectedHash: Hex): UsdcDelayedSuccessorApproval { return loadApproval(proposal, serialized, expectedHash, productionProposals, productionApprovals); }
export function loadUsdcDelayedSuccessorApprovalForTestsOnly(proposal: UsdcDelayedSuccessorProposal, serialized: string, expectedHash: Hex): UsdcDelayedSuccessorApproval { return loadApproval(proposal, serialized, expectedHash, testProposals, testApprovals); }
export function assertUsdcDelayedSuccessorAuthorization(proposal: UsdcDelayedSuccessorProposal, approval: UsdcDelayedSuccessorApproval): void { if (!productionProposals.has(proposal) || productionApprovals.get(approval) !== proposal) throw new Error("delayed successor production authorization is not opaque and exactly bound"); }
export function assertUsdcDelayedSuccessorAuthorizationForTestsOnly(proposal: UsdcDelayedSuccessorProposal, approval: UsdcDelayedSuccessorApproval): void { if (!testProposals.has(proposal) || testApprovals.get(approval) !== proposal) throw new Error("delayed successor test authorization is not opaque and exactly bound"); }
export function getUsdcDelayedSuccessorApprovalPublicValue(approval: UsdcDelayedSuccessorApproval): Readonly<Record<string, unknown>> { const value = publicApprovals.get(approval); if (!value || !same(publicHash(value), approval.approvalHash)) throw new Error("delayed successor approval is not genuine"); return structuredClone(value); }

function attachAuthorized(journal: UsdcDelayedSuccessorSource["journal"], proposal: UsdcDelayedSuccessorProposal, approval: UsdcDelayedSuccessorApproval): UsdcDelayedSuccessorSource["journal"] & { usdcDelayedSuccessor: UsdcDelayedSuccessorStorage } {
  if (journal.usdcDelayedSuccessor !== undefined) throw new Error("journal already has a delayed successor attachment");
  if (proposalJournals.get(proposal) !== journal || !same(publicHash(usdcDelayedSuccessorPredecessorValue(journal)), proposal.sourceJournalHash)) throw new Error("delayed successor attachment source changed or detached");
  const storage: UsdcDelayedSuccessorStorage = { schemaVersion: 1, scope: USDC_DELAYED_SUCCESSOR_SCOPE, sourceJournalHash: proposal.sourceJournalHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, actionCommitments: proposal.actions.map(({ id, commitment }) => ({ id, commitment })), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maxBroadcastAttempts: 1, repairAuthority: "NONE", actions: proposal.actions.map(({ id, commitment }) => ({ id, commitment, status: "approved" as const })) };
  (journal as UsdcDelayedSuccessorSource["journal"] & { usdcDelayedSuccessor: UsdcDelayedSuccessorStorage }).usdcDelayedSuccessor = storage;
  return journal as UsdcDelayedSuccessorSource["journal"] & { usdcDelayedSuccessor: UsdcDelayedSuccessorStorage };
}
export function attachUsdcDelayedSuccessor(journal: UsdcDelayedSuccessorSource["journal"], proposal: UsdcDelayedSuccessorProposal, approval: UsdcDelayedSuccessorApproval) { assertUsdcDelayedSuccessorAuthorization(proposal, approval); return attachAuthorized(journal, proposal, approval); }
export function attachUsdcDelayedSuccessorForTestsOnly(journal: UsdcDelayedSuccessorSource["journal"], proposal: UsdcDelayedSuccessorProposal, approval: UsdcDelayedSuccessorApproval) { assertUsdcDelayedSuccessorAuthorizationForTestsOnly(proposal, approval); return attachAuthorized(journal, proposal, approval); }

export function assertUsdcDelayedSuccessorAdmission(proposal: UsdcDelayedSuccessorProposal, actionId: string, chainTimestamp: bigint, now: Date, phase: "review" | "scenario" | "private" | "broadcast"): void {
  if (!productionProposals.has(proposal) && !testProposals.has(proposal)) throw new Error("delayed successor admission requires opaque proposal");
  const index = proposal.actions.findIndex(item => item.id === actionId); if (index < 0) throw new Error("action is outside delayed successor catalog");
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000)), deadline = BigInt(proposal.deadline), expires = BigInt(proposal.observer.expiresAt);
  if (chainTimestamp >= deadline || nowSeconds >= deadline || chainTimestamp >= expires || nowSeconds >= expires) throw new Error("delayed successor deadline or observer expiry elapsed");
  const remaining = [deadline-chainTimestamp,deadline-nowSeconds,expires-chainTimestamp,expires-nowSeconds].reduce((a,b)=>a<b?a:b);
  let required = 1n;
  if (phase === "review") required = 1_800n;
  if (phase === "scenario") { const groupIndex = DELAYED_SUCCESSOR_GROUPS.findIndex(group => index + 1 >= group.start && index + 1 <= group.end); required = DELAYED_SUCCESSOR_GROUPS.slice(groupIndex).reduce((sum, group) => sum + BigInt(group.budgetSeconds), 300n); }
  if ((phase === "private" || phase === "broadcast") && proposal.actions[index]!.kind === "queue-proposal") required = 900n;
  if (remaining < required) throw new Error(`delayed successor admission has insufficient remaining time for ${required} seconds`);
}
