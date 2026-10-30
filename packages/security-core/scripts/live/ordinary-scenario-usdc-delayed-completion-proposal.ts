import { encodeFunctionData, hashTypedData, type Address, type Hex } from "viem";
import { buildCancellationTransaction, buildExecutionTransaction, buildQueueTransaction, queueFingerprint, queueMonitoringFingerprint, type DelayQueueItem } from "../../src/queue/delay";
import { SAFE_TX_TYPES } from "../../src/signers/types";
import { sha256 } from "../plan-deployment";
import type { OrdinaryScenarioActionRecord } from "./ordinary-scenario-executor";
import type { ContinuationActionCaps, ContinuationObserverBinding, ExpiredHashlessContinuationAction } from "./ordinary-scenario-hashless-continuation";
import {
  USDC_DELAYED_COMPLETION_SCOPE,
  isVerifiedUsdcDelayedCompletionCertificate,
  isVerifiedUsdcDelayedCompletionCertificateForTestsOnly,
  usdcDelayedCompletionPredecessorValue,
  type UsdcDelayedCompletionSource,
  type VerifiedUsdcDelayedCompletionCertificate,
} from "./ordinary-scenario-usdc-delayed-completion-certificate";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PHASE_LIMIT = 50_000_000_000_000_000n;
const PRIOR_PRINCIPAL = 60_000_000_000_002n;
const PRIOR_ACTUAL_GAS_COST = 71_161_126_272_984n;
const KNOWN_OLD_SUCCESSOR_CHARGE = 124_953_955_544n;
const REMAINING_OLD_SUCCESSOR_ALLOWANCE = 15_955_630_044_456n;
const RESERVATION = 9_340_292_000_000n;
const USDC_AMOUNT = 31_000_000n;
const TOKEN_ABI = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const DELAY_ABI = [{ type: "function", name: "skipExpired", stateMutability: "nonpayable", inputs: [] }] as const;

export const DELAYED_COMPLETION_AUTHORITY_EVIDENCE_HASH = sha256({ scope: USDC_DELAYED_COMPLETION_SCOPE, userAuthority: "z-only-delayed-tier-completion-approved-2026-10-30", newGrossUsdc: "31000000", aggregateGrossUsdc: "51000000", repairAuthority: "NONE" }) as Hex;
export const DELAYED_COMPLETION_SCHEDULE = Object.freeze({ review: "600", execution: "1800", confirmations: "180", delivery: "60", acknowledgement: "180", keylessConfirmation: "180", reviewAdmission: "3600", initialExecutionAdmission: "3000", reconciliationMargin: "300" } as const);
export const DELAYED_COMPLETION_GROUPS = Object.freeze([
  Object.freeze({ start: 1 as const, end: 2 as const, budgetSeconds: "300" as const }),
  Object.freeze({ start: 3 as const, end: 6 as const, budgetSeconds: "600" as const }),
  Object.freeze({ start: 7 as const, end: 10 as const, budgetSeconds: "1200" as const }),
  Object.freeze({ start: 11 as const, end: 13 as const, budgetSeconds: "600" as const }),
]);

const IDS = Object.freeze(["prefund-all", "direct-above-y-rejection", "queue-cancel", "queue-cancel-early-rejection", "queue-cancel-action", "queue-cancelled-execution-rejection", "queue-expiry", "queue-expiry-early-rejection", "queue-expiry-skip", "queue-expired-execution-rejection", "queue-execute", "queue-execute-early-rejection", "queue-ready-execute"].map(id => `usdc-delayed-completion-${id}`));
const DEPENDENCIES = Object.freeze([
  Object.freeze(["usdc-successor-step-up-contract"]), Object.freeze([IDS[0]!]), Object.freeze([IDS[0]!]), Object.freeze([IDS[2]!]), Object.freeze([IDS[2]!]), Object.freeze([IDS[4]!]), Object.freeze([IDS[4]!]), Object.freeze([IDS[6]!]), Object.freeze([IDS[6]!]), Object.freeze([IDS[8]!]), Object.freeze([IDS[8]!]), Object.freeze([IDS[10]!]), Object.freeze([IDS[11]!]),
]);

type Schedule = typeof DELAYED_COMPLETION_SCHEDULE;
type Group = typeof DELAYED_COMPLETION_GROUPS[number];
type Reservation = Readonly<{ phaseLimitWei: string; priorActualGasCostWei: string; priorPrincipalWei: string; knownOldSuccessorChargeWei: string; remainingOldSuccessorAllowanceWei: string; successorMaximumReservationWei: string; spareOldSuccessorAllowanceWei: string; maximumCumulativeOutlayWei: string; newGrossUsdcAllowance: string; aggregateGrossUsdcAllowance: string; inwardUsdcFunding: string }>;
declare const proposalBrand: unique symbol;
export type UsdcDelayedCompletionProposal = Readonly<{ schemaVersion: 1; scope: typeof USDC_DELAYED_COMPLETION_SCOPE; authorization: "NONE"; chainId: 11155111; authorityEvidenceHash: Hex; sourceJournalHash: Hex; certificateHash: Hex; snapshot: Readonly<{ blockNumber: string; blockHash: Hex; timestamp: string }>; minimumOuterNonce: number; effectivePeriod: string; deadline: string; observer: ContinuationObserverBinding; schedule: Schedule; groups: readonly Group[]; caps: ContinuationActionCaps; reservation: Reservation; maxBroadcastAttempts: 1; repairAuthority: "NONE"; actions: readonly ExpiredHashlessContinuationAction[]; proposalHash: Hex; readonly [proposalBrand]: true }>;
declare const approvalBrand: unique symbol;
export type UsdcDelayedCompletionApproval = Readonly<{ approvalHash: Hex; readonly [approvalBrand]: true }>;
export type UsdcDelayedCompletionStorage = Readonly<{ schemaVersion: 1; scope: typeof USDC_DELAYED_COMPLETION_SCOPE; sourceJournalHash: Hex; certificateHash: Hex; proposalHash: Hex; approvalHash: Hex; minimumOuterNonce: number; effectivePeriod: string; deadline: string; actionCommitments: readonly Readonly<{ id: string; commitment: Hex }>[]; maximumReservationWei: string; maxBroadcastAttempts: 1; repairAuthority: "NONE"; actions: Array<Readonly<{ id: string; commitment: Hex; status: "approved" }> | OrdinaryScenarioActionRecord> }>;

const productionProposals = new WeakSet<object>();
const testProposals = new WeakSet<object>();
const productionApprovals = new WeakMap<object, UsdcDelayedCompletionProposal>();
const testApprovals = new WeakMap<object, UsdcDelayedCompletionProposal>();
const publicApprovals = new WeakMap<object, Readonly<Record<string, unknown>>>();
const proposalJournals = new WeakMap<object, UsdcDelayedCompletionSource["journal"]>();
const same = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const freeze = <T>(value: T): T => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) freeze(child); } return value; };
const publicHash = (value: unknown): Hex => sha256(value) as Hex;
const exactKeys = (value: Record<string, unknown>, expected: readonly string[], label: string): void => { const actual = Object.keys(value).sort(), wanted = [...expected].sort(); if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} shape mismatch`); };
const decimal = (value: unknown, label: string): bigint => { if (typeof value !== "string" || !DECIMAL.test(value)) throw new Error(`${label} must be a canonical decimal string`); return BigInt(value); };

function validateCaps(caps: ContinuationActionCaps): ContinuationActionCaps {
  const expected = { fundingGasLimit: "740292", safeExecutionGasLimit: "2000000", publicDelayGasLimit: "300000", maxFeePerGas: "1000000", maxPriorityFeePerGas: "1000000" };
  if (JSON.stringify(caps) !== JSON.stringify(expected)) throw new Error("delayed completion caps must equal the reviewed literals");
  return freeze({ ...caps });
}

function validateObserver(observer: ContinuationObserverBinding, certificate: VerifiedUsdcDelayedCompletionCertificate, deadline: bigint, source: UsdcDelayedCompletionSource): ContinuationObserverBinding {
  exactKeys(observer as unknown as Record<string, unknown>, ["kind", "publicId", "endpointHash", "startupEvidenceHash", "probeEvidenceHash", "independentFromProposer", "readyAt", "workflowScheduleSeconds", "requiredThrough", "expiresAt"], "delayed completion observer");
  const workflow = { review: "600", execution: "1800", confirmations: "180", delivery: "60", acknowledgement: "180", keylessConfirmation: "180" };
  if (observer.kind !== "https-webhook" || observer.independentFromProposer !== true || JSON.stringify(observer.workflowScheduleSeconds) !== JSON.stringify(workflow) || !observer.publicId.startsWith("temporary-test-receiver:") || !observer.publicId.endsWith(observer.endpointHash) || !HASH.test(observer.endpointHash) || !HASH.test(observer.startupEvidenceHash) || !HASH.test(observer.probeEvidenceHash)) throw new Error("delayed completion observer or workflow is invalid");
  const old = source.freshProposal.observer;
  if ([observer.endpointHash, observer.startupEvidenceHash, observer.probeEvidenceHash].some(value => [old.endpointHash, old.startupEvidenceHash, old.probeEvidenceHash].some(prior => same(value, prior)))) throw new Error("delayed completion observer must be fresh");
  const ready = decimal(observer.readyAt, "observer readyAt"), required = decimal(observer.requiredThrough, "observer requiredThrough"), expires = decimal(observer.expiresAt, "observer expiresAt");
  if (ready < BigInt(certificate.snapshot.timestamp) || required !== ready + 3_600n || deadline - ready < 3_600n || expires < required) throw new Error("delayed completion observer lacks 3600-second coverage");
  return freeze({ ...observer, workflowScheduleSeconds: { ...observer.workflowScheduleSeconds } });
}

type State = ExpiredHashlessContinuationAction["before"];
const state = (safeNonce: number, queueNonce: number, txNonce: number, safeUsdc: number, funderUsdc: number, queueStatus = "EMPTY", activeQueue: number | null = null, fingerprint: Hex | null = null): State => freeze({ safeNonce: String(safeNonce), delayQueueNonce: String(queueNonce), delayTxNonce: String(txNonce), safeNativeBalance: "0", safeUsdcBalance: String(safeUsdc), funderUsdcBalance: String(funderUsdc), nativeBaseSpent: "10000000000000", nativeInstantSpent: "30000000000000", usdcBaseSpent: "10000000", usdcInstantSpent: "20000000", queueStatus, queueNonce: activeQueue === null ? null : String(activeQueue), queueFingerprint: fingerprint });
const action = (value: Omit<ExpiredHashlessContinuationAction, "commitment">): ExpiredHashlessContinuationAction => freeze({ ...value, commitment: publicHash(value) });

function safeTransaction(source: UsdcDelayedCompletionSource, to: Address, data: Hex, nonce: number) {
  const tx = freeze({ to, value: "0", data, operation: 0 as const, safeTxGas: "0" as const, baseGas: "0" as const, gasPrice: "0" as const, gasToken: ZERO, refundReceiver: ZERO, nonce: String(nonce) });
  const safeTxHash = hashTypedData({ domain: { chainId: 11_155_111, verifyingContract: source.historical.prior.original.safe }, types: { SafeTx: SAFE_TX_TYPES }, primaryType: "SafeTx", message: { ...tx, value: 0n, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, nonce: BigInt(nonce) } });
  return { tx, safeTxHash };
}

function buildActions(source: UsdcDelayedCompletionSource, caps: ContinuationActionCaps): readonly ExpiredHashlessContinuationAction[] {
  const identity = source.historical.prior.original;
  const transfer = encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [identity.recipient, USDC_AMOUNT] });
  const fund = encodeFunctionData({ abi: TOKEN_ABI, functionName: "transfer", args: [identity.safe, USDC_AMOUNT] });
  const queue = (nonce: number) => {
    const item = { safe: identity.safe, delay: identity.delay, to: identity.usdc, value: 0n, data: transfer, operation: 0 as const, queueNonce: BigInt(nonce) } satisfies DelayQueueItem;
    return { item, binding: freeze({ queueNonce: String(nonce), fingerprint: queueFingerprint(item), monitoringFingerprint: queueMonitoringFingerprint(item), to: item.to, value: "0", data: item.data, operation: 0 as const }) };
  };
  const q4 = queue(4), q5 = queue(5), q6 = queue(6);
  const q4tx = buildQueueTransaction(q4.item), q5tx = buildQueueTransaction(q5.item), q6tx = buildQueueTransaction(q6.item);
  const direct = safeTransaction(source, identity.usdc, transfer, 10), queue4 = safeTransaction(source, q4tx.to, q4tx.data, 10), cancel4Tx = buildCancellationTransaction(identity.delay, 5n), cancel4 = safeTransaction(source, cancel4Tx.to, cancel4Tx.data, 11), queue5 = safeTransaction(source, q5tx.to, q5tx.data, 12), queue6 = safeTransaction(source, q6tx.to, q6tx.data, 13);
  const execute4 = buildExecutionTransaction(q4.item), execute5 = buildExecutionTransaction(q5.item), execute6 = buildExecutionTransaction(q6.item), skip = encodeFunctionData({ abi: DELAY_ABI, functionName: "skipExpired" });
  const s0 = state(10,4,4,0,40_000_000), s1 = state(10,4,4,31_000_000,9_000_000), s2 = state(11,5,4,31_000_000,9_000_000,"QUEUED",4,q4.binding.fingerprint), s3 = state(12,5,5,31_000_000,9_000_000,"CANCELLED_CONDITIONAL",4,q4.binding.fingerprint), s4 = state(13,6,5,31_000_000,9_000_000,"QUEUED",5,q5.binding.fingerprint), s5 = state(13,6,6,31_000_000,9_000_000,"EXPIRED_CONDITIONAL",5,q5.binding.fingerprint), s6 = state(14,7,6,31_000_000,9_000_000,"QUEUED",6,q6.binding.fingerprint), s7 = state(14,7,7,0,40_000_000,"EXECUTED",6,q6.binding.fingerprint);
  const common = (index: number, kind: string, expectedOutcome: "success" | "rejection", signerRoles: readonly string[], transaction: { to: Address; value: bigint; data: Hex }, before: State, after: State, gasLimitCap: string, safe?: ReturnType<typeof safeTransaction>, binding?: typeof q4.binding) => action({ id: IDS[index]!, kind, asset: "USDC", expectedOutcome, signerRoles: freeze([...signerRoles]), dependsOn: DEPENDENCIES[index]!, transaction: freeze({ to: transaction.to, value: transaction.value.toString(), data: transaction.data, operation: 0 as const }), safeTransaction: safe?.tx, safeTxHash: safe?.safeTxHash, queue: binding, before, after, gasLimitCap, maxFeePerGasCap: caps.maxFeePerGas, maxPriorityFeePerGasCap: caps.maxPriorityFeePerGas });
  return freeze([
    common(0,"controlled-recipient-funding","success",["funder"],{to:identity.usdc,value:0n,data:fund},s0,s1,caps.fundingGasLimit),
    common(1,"expected-direct-rejection","rejection",["primary-passkey","safe-contract-secondary"],{to:identity.safe,value:0n,data:direct.tx.data},s1,s1,caps.safeExecutionGasLimit,direct),
    common(2,"queue-proposal","success",["primary-passkey","safe-contract-secondary"],q4tx,s1,s2,caps.safeExecutionGasLimit,queue4,q4.binding),
    common(3,"expected-early-rejection","rejection",[],execute4,s2,s2,caps.publicDelayGasLimit,undefined,q4.binding),
    common(4,"queue-cancellation","success",["primary-passkey","safe-contract-secondary"],cancel4Tx,s2,s3,caps.safeExecutionGasLimit,cancel4,q4.binding),
    common(5,"expected-cancelled-rejection","rejection",[],execute4,s3,s3,caps.publicDelayGasLimit,undefined,q4.binding),
    common(6,"queue-proposal","success",["primary-passkey","safe-contract-secondary"],q5tx,s3,s4,caps.safeExecutionGasLimit,queue5,q5.binding),
    common(7,"expected-early-rejection","rejection",[],execute5,s4,s4,caps.publicDelayGasLimit,undefined,q5.binding),
    common(8,"queue-expiry","success",[],{to:identity.delay,value:0n,data:skip},s4,s5,caps.publicDelayGasLimit,undefined,q5.binding),
    common(9,"expected-expired-rejection","rejection",[],execute5,s5,s5,caps.publicDelayGasLimit,undefined,q5.binding),
    common(10,"queue-proposal","success",["primary-passkey","safe-contract-secondary"],q6tx,s5,s6,caps.safeExecutionGasLimit,queue6,q6.binding),
    common(11,"expected-early-rejection","rejection",[],execute6,s6,s6,caps.publicDelayGasLimit,undefined,q6.binding),
    common(12,"ready-delay-execution","success",[],execute6,s6,s7,caps.publicDelayGasLimit,undefined,q6.binding),
  ]);
}

type ProposalInput = Readonly<{ source: UsdcDelayedCompletionSource; certificate: VerifiedUsdcDelayedCompletionCertificate; observer: ContinuationObserverBinding; caps: ContinuationActionCaps }>;
function buildProposal(input: ProposalInput, testOnly: boolean): UsdcDelayedCompletionProposal {
  const verified = testOnly ? isVerifiedUsdcDelayedCompletionCertificateForTestsOnly(input.certificate) : isVerifiedUsdcDelayedCompletionCertificate(input.certificate);
  if (!verified || !same(input.source.sourceJournalHash, input.certificate.sourceJournalHash) || !same(publicHash(usdcDelayedCompletionPredecessorValue(input.source.journal)), input.source.sourceJournalHash)) throw new Error("delayed completion source and opaque certificate are not exactly bound");
  const effectivePeriod = input.certificate.effectivePeriod, deadline = effectivePeriod + 86_400n, caps = validateCaps(input.caps), observer = validateObserver(input.observer, input.certificate, deadline, input.source), actions = buildActions(input.source, caps);
  const reservation = actions.filter(item => item.expectedOutcome === "success").reduce((sum, item) => sum + BigInt(item.gasLimitCap) * BigInt(item.maxFeePerGasCap), 0n);
  if (actions.length !== 13 || reservation !== RESERVATION) throw new Error("delayed completion exact thirteen-row reservation mismatch");
  const spare = REMAINING_OLD_SUCCESSOR_ALLOWANCE - reservation, maximum = PRIOR_ACTUAL_GAS_COST + PRIOR_PRINCIPAL + reservation;
  if (maximum !== 140_501_418_272_986n || maximum > PHASE_LIMIT) throw new Error("delayed completion phase ceiling mismatch");
  const reservationValue = freeze({ phaseLimitWei: PHASE_LIMIT.toString(), priorActualGasCostWei: PRIOR_ACTUAL_GAS_COST.toString(), priorPrincipalWei: PRIOR_PRINCIPAL.toString(), knownOldSuccessorChargeWei: KNOWN_OLD_SUCCESSOR_CHARGE.toString(), remainingOldSuccessorAllowanceWei: REMAINING_OLD_SUCCESSOR_ALLOWANCE.toString(), successorMaximumReservationWei: reservation.toString(), spareOldSuccessorAllowanceWei: spare.toString(), maximumCumulativeOutlayWei: maximum.toString(), newGrossUsdcAllowance: "31000000", aggregateGrossUsdcAllowance: "51000000", inwardUsdcFunding: "31000000" });
  const body = { schemaVersion: 1 as const, scope: USDC_DELAYED_COMPLETION_SCOPE, authorization: "NONE" as const, chainId: 11_155_111 as const, authorityEvidenceHash: DELAYED_COMPLETION_AUTHORITY_EVIDENCE_HASH, sourceJournalHash: input.source.sourceJournalHash, certificateHash: input.certificate.certificateHash, snapshot: freeze({ blockNumber: input.certificate.snapshot.blockNumber, blockHash: input.certificate.snapshot.blockHash, timestamp: input.certificate.snapshot.timestamp }), minimumOuterNonce: input.certificate.minimumOuterNonce, effectivePeriod: effectivePeriod.toString(), deadline: deadline.toString(), observer, schedule: DELAYED_COMPLETION_SCHEDULE, groups: DELAYED_COMPLETION_GROUPS, caps, reservation: reservationValue, maxBroadcastAttempts: 1 as const, repairAuthority: "NONE" as const, actions };
  const proposal = freeze({ ...body, proposalHash: publicHash(body) }) as unknown as UsdcDelayedCompletionProposal;
  (testOnly ? testProposals : productionProposals).add(proposal); proposalJournals.set(proposal, input.source.journal);
  return proposal;
}

export function createUsdcDelayedCompletionProposal(input: ProposalInput): UsdcDelayedCompletionProposal { return buildProposal(input, false); }
/** Test-only proposal authority; production approval and execution boundaries reject it. */
export function createUsdcDelayedCompletionProposalForTestsOnly(input: ProposalInput): UsdcDelayedCompletionProposal { return buildProposal(input, true); }
export function parseUsdcDelayedCompletionProposal(serialized: string, source: UsdcDelayedCompletionSource, certificate: VerifiedUsdcDelayedCompletionCertificate): UsdcDelayedCompletionProposal {
  let parsed: any; try { parsed = JSON.parse(serialized); } catch { throw new Error("delayed completion proposal must be JSON"); }
  const expected = buildProposal({ source, certificate, observer: parsed?.observer, caps: parsed?.caps }, false);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("delayed completion proposal shape, catalog, or hash drift");
  return expected;
}
export function parseUsdcDelayedCompletionProposalForTestsOnly(serialized: string, source: UsdcDelayedCompletionSource, certificate: VerifiedUsdcDelayedCompletionCertificate): UsdcDelayedCompletionProposal { let parsed: any; try { parsed = JSON.parse(serialized); } catch { throw new Error("delayed completion proposal must be JSON"); } const expected = buildProposal({ source, certificate, observer: parsed?.observer, caps: parsed?.caps }, true); if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new Error("delayed completion proposal shape, catalog, or hash drift"); return expected; }

function loadApproval(proposal: UsdcDelayedCompletionProposal, serialized: string, expectedHash: Hex, proposals: WeakSet<object>, approvals: WeakMap<object, UsdcDelayedCompletionProposal>): UsdcDelayedCompletionApproval {
  if (!proposals.has(proposal)) throw new Error("delayed completion proposal is not opaque for this authority");
  let value: any; try { value = JSON.parse(serialized); } catch { throw new Error("delayed completion approval must be JSON"); }
  const approvalHash = publicHash(value);
  if (!same(approvalHash, expectedHash)) throw new Error("delayed completion approval hash mismatch");
  exactKeys(value, ["schemaVersion", "scope", "authorization", "authorityEvidenceHash", "proposalHash", "sourceJournalHash", "certificateHash", "snapshot", "minimumOuterNonce", "effectivePeriod", "deadline", "observer", "schedule", "groups", "caps", "reservation", "maxBroadcastAttempts", "repairAuthority", "approvedActions"], "delayed completion approval");
  if (value.schemaVersion !== 1 || value.scope !== proposal.scope || value.authorization !== "FOCUSED_BOUNDED_DELAYED_COMPLETION_AUTHORIZATION" || value.authorityEvidenceHash !== proposal.authorityEvidenceHash || value.proposalHash !== proposal.proposalHash || value.sourceJournalHash !== proposal.sourceJournalHash || value.certificateHash !== proposal.certificateHash || value.minimumOuterNonce !== proposal.minimumOuterNonce || value.effectivePeriod !== proposal.effectivePeriod || value.deadline !== proposal.deadline || value.maxBroadcastAttempts !== 1 || value.repairAuthority !== "NONE" || JSON.stringify(value.snapshot) !== JSON.stringify(proposal.snapshot) || JSON.stringify(value.observer) !== JSON.stringify(proposal.observer) || JSON.stringify(value.schedule) !== JSON.stringify(proposal.schedule) || JSON.stringify(value.groups) !== JSON.stringify(proposal.groups) || JSON.stringify(value.caps) !== JSON.stringify(proposal.caps) || JSON.stringify(value.reservation) !== JSON.stringify(proposal.reservation)) throw new Error("delayed completion approval binding mismatch");
  if (!Array.isArray(value.approvedActions) || value.approvedActions.length !== 13 || value.approvedActions.some((item: any, index: number) => item.id !== proposal.actions[index]!.id || item.commitment !== proposal.actions[index]!.commitment)) throw new Error("delayed completion approved action mismatch");
  const approval = freeze({ approvalHash }) as UsdcDelayedCompletionApproval; approvals.set(approval, proposal); publicApprovals.set(approval, freeze(structuredClone(value))); return approval;
}
export function loadUsdcDelayedCompletionApproval(proposal: UsdcDelayedCompletionProposal, serialized: string, expectedHash: Hex): UsdcDelayedCompletionApproval { return loadApproval(proposal, serialized, expectedHash, productionProposals, productionApprovals); }
export function loadUsdcDelayedCompletionApprovalForTestsOnly(proposal: UsdcDelayedCompletionProposal, serialized: string, expectedHash: Hex): UsdcDelayedCompletionApproval { return loadApproval(proposal, serialized, expectedHash, testProposals, testApprovals); }

export function assertUsdcDelayedCompletionAuthorization(proposal: UsdcDelayedCompletionProposal, approval: UsdcDelayedCompletionApproval): void { if (!productionProposals.has(proposal) || productionApprovals.get(approval) !== proposal) throw new Error("delayed completion production authorization is not opaque and exactly bound"); }
export function assertUsdcDelayedCompletionAuthorizationForTestsOnly(proposal: UsdcDelayedCompletionProposal, approval: UsdcDelayedCompletionApproval): void { if (!testProposals.has(proposal) || testApprovals.get(approval) !== proposal) throw new Error("delayed completion test authorization is not opaque and exactly bound"); }
export function getUsdcDelayedCompletionApprovalPublicValue(approval: UsdcDelayedCompletionApproval): Readonly<Record<string, unknown>> { const value = publicApprovals.get(approval); if (!value || !same(publicHash(value), approval.approvalHash)) throw new Error("delayed completion approval is not genuine"); return structuredClone(value); }

export function attachUsdcDelayedCompletion(journal: UsdcDelayedCompletionSource["journal"], proposal: UsdcDelayedCompletionProposal, approval: UsdcDelayedCompletionApproval): UsdcDelayedCompletionSource["journal"] & { usdcDelayedCompletion: UsdcDelayedCompletionStorage } {
  assertUsdcDelayedCompletionAuthorization(proposal, approval);
  return attachAuthorized(journal, proposal, approval);
}
export function attachUsdcDelayedCompletionForTestsOnly(journal: UsdcDelayedCompletionSource["journal"], proposal: UsdcDelayedCompletionProposal, approval: UsdcDelayedCompletionApproval): UsdcDelayedCompletionSource["journal"] & { usdcDelayedCompletion: UsdcDelayedCompletionStorage } { assertUsdcDelayedCompletionAuthorizationForTestsOnly(proposal, approval); return attachAuthorized(journal, proposal, approval); }
function attachAuthorized(journal: UsdcDelayedCompletionSource["journal"], proposal: UsdcDelayedCompletionProposal, approval: UsdcDelayedCompletionApproval): UsdcDelayedCompletionSource["journal"] & { usdcDelayedCompletion: UsdcDelayedCompletionStorage } {
  if (journal.usdcDelayedCompletion !== undefined) throw new Error("journal already has a delayed completion attachment");
  if (proposalJournals.get(proposal) !== journal || !same(publicHash(usdcDelayedCompletionPredecessorValue(journal)), proposal.sourceJournalHash)) throw new Error("delayed completion attachment source changed or detached");
  const storage: UsdcDelayedCompletionStorage = { schemaVersion: 1, scope: USDC_DELAYED_COMPLETION_SCOPE, sourceJournalHash: proposal.sourceJournalHash, certificateHash: proposal.certificateHash, proposalHash: proposal.proposalHash, approvalHash: approval.approvalHash, minimumOuterNonce: proposal.minimumOuterNonce, effectivePeriod: proposal.effectivePeriod, deadline: proposal.deadline, actionCommitments: proposal.actions.map(({ id, commitment }) => ({ id, commitment })), maximumReservationWei: proposal.reservation.successorMaximumReservationWei, maxBroadcastAttempts: 1, repairAuthority: "NONE", actions: proposal.actions.map(({ id, commitment }) => ({ id, commitment, status: "approved" as const })) };
  journal.usdcDelayedCompletion = storage;
  return journal as typeof journal & { usdcDelayedCompletion: UsdcDelayedCompletionStorage };
}

export function assertUsdcDelayedCompletionAdmission(proposal: UsdcDelayedCompletionProposal, actionId: string, chainTimestamp: bigint, now: Date, phase: "review" | "scenario" | "private" | "broadcast"): void {
  if (!productionProposals.has(proposal) && !testProposals.has(proposal)) throw new Error("delayed completion admission requires opaque proposal");
  const index = proposal.actions.findIndex(item => item.id === actionId); if (index < 0) throw new Error("action is outside delayed completion catalog");
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000)), deadline = BigInt(proposal.deadline), expires = BigInt(proposal.observer.expiresAt);
  if (chainTimestamp >= deadline || nowSeconds >= deadline || chainTimestamp >= expires || nowSeconds >= expires) throw new Error("delayed completion deadline or observer expiry elapsed");
  const remaining = [deadline-chainTimestamp,deadline-nowSeconds,expires-chainTimestamp,expires-nowSeconds].reduce((a,b)=>a<b?a:b);
  let required = 1n;
  if (phase === "review") required = 3_600n;
  if (phase === "scenario") { const groupIndex = DELAYED_COMPLETION_GROUPS.findIndex(group => index + 1 >= group.start && index + 1 <= group.end); required = DELAYED_COMPLETION_GROUPS.slice(groupIndex).reduce((sum, group) => sum + BigInt(group.budgetSeconds), 300n); }
  if ((phase === "private" || phase === "broadcast") && proposal.actions[index]!.kind === "queue-proposal") { const group = DELAYED_COMPLETION_GROUPS.find(item => index + 1 >= item.start && index + 1 <= item.end)!; required = BigInt(group.budgetSeconds) + 300n; }
  if (remaining < required) throw new Error(`delayed completion admission has insufficient remaining time for ${required} seconds`);
}
