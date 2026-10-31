import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { PWA_RECIPIENT, SEPOLIA_CHAIN_ID, SEPOLIA_USDC_ADDRESS } from "../../src/pwa/profile";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const PROCESS_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_FEE_PER_GAS = 1_000_000_000n;
const MAX_PRIORITY_FEE_PER_GAS = 1_000_000_000n;

export const LOCAL_PWA_ACTION_IDS = Object.freeze([
  "provision", "fund-8-usdc", "base-1-usdc", "step-up-2-usdc", "queue-4-usdc",
  "cancel-queue", "requeue-4-usdc", "early-reject", "ready-execute",
] as const);

export type LocalPwaActionId = typeof LOCAL_PWA_ACTION_IDS[number];
export type LocalPwaReviewInput = Readonly<{
  formatVersion: 1;
  profileId: "local";
  chainId: typeof SEPOLIA_CHAIN_ID;
  safe: Address;
  guard: Address;
  delay: Address;
  usdc: Address;
  recipient: Address;
  primaryCredentialHash: Hex;
  secondaryCredentialHash: Hex;
  deploymentsHash: Hex;
  policyHash: Hex;
  topologyReportHash: Hex;
  observer: Readonly<{ processId: string; executableHash: Hex; sources: readonly [string, string]; confirmations: number }>;
  deadline: string;
}>;

export type LocalPwaReviewAction = Readonly<{
  id: LocalPwaActionId;
  ordinal: number;
  broadcast: boolean;
  amount: string;
  requiredApprovals: readonly ("primary" | "secondary")[];
  maxGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}>;

export type LocalPwaReview = Readonly<LocalPwaReviewInput & {
  scope: "sepolia-pwa-localhost-rehearsal";
  authorization: "NONE";
  principal: "8000000";
  actions: readonly LocalPwaReviewAction[];
  maximumGas: string;
  maximumEthOutlayWei: string;
  expectedTerminal: Readonly<{ safeUsdcBalance: "1000000"; recipientUsdcIncrease: "7000000"; queueDepth: "0"; baseSpent: "1000000"; instantSpent: "3000000" }>;
  reviewHash: Hex;
}>;

export type LocalPwaApproval = Readonly<{
  formatVersion: 1;
  scope: "sepolia-pwa-localhost-one-action";
  reviewHash: Hex;
  actionId: LocalPwaActionId;
  adapterHash: Hex;
  expiresAt: string;
  approvalHash: Hex;
}>;

export type LocalPwaReceiptEvidence = Readonly<{
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  observerRecordHash?: Hex;
}>;

export type LocalPwaPreparedAction = Readonly<{ actionId: LocalPwaActionId; transactionHash: Hex; attemptHash: Hex }>;
export type LocalPwaActionAdapter = Readonly<{
  prepare(action: LocalPwaReviewAction, review: LocalPwaReview): Promise<LocalPwaPreparedAction>;
  broadcast(prepared: LocalPwaPreparedAction): Promise<LocalPwaReceiptEvidence>;
  proveRejection(action: LocalPwaReviewAction, review: LocalPwaReview): Promise<Readonly<{ proofHash: Hex; blockNumber: string; blockHash: Hex }>>;
}>;
export type LocalPwaResumeAdapter = Readonly<{ reconcile(transactionHash: Hex): Promise<LocalPwaReceiptEvidence | null> }>;

type JournalAction = Readonly<{
  id: LocalPwaActionId;
  status: "planned" | "pending" | "confirmed" | "reverted" | "proved";
  transactionHash?: Hex;
  attemptHash?: Hex;
  blockNumber?: string;
  blockHash?: Hex;
  observerRecordHash?: Hex;
  proofHash?: Hex;
}>;
export type LocalPwaJournal = Readonly<{ formatVersion: 1; chainId: typeof SEPOLIA_CHAIN_ID; reviewHash: Hex; actions: readonly JournalAction[] }>;
export type LocalPwaJournalStore = Readonly<{ load(): LocalPwaJournal; save(journal: LocalPwaJournal): void; close(): void }>;

const approved = new WeakSet<object>();

function canonical(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(item as Record<string, unknown>).sort()) output[key] = visit((item as Record<string, unknown>)[key]);
      return output;
    }
    return item;
  };
  return JSON.stringify(visit(value));
}

function hash(value: unknown): Hex { return keccak256(stringToHex(canonical(value))); }
function same(left: string, right: string): boolean { return left.toLowerCase() === right.toLowerCase(); }
function assertHash(value: unknown, label: string): asserts value is Hex { if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be bytes32 hex`); }
function assertKeys(value: object, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(`${label} has unsupported fields`);
}
function assertPlainCapability(value: object, keys: readonly string[], label: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain capability object`);
  assertKeys(value, keys, label);
}
function decimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${label} must be canonical decimal`);
  return BigInt(value);
}

const ACTION_BLUEPRINTS = Object.freeze([
  ["provision", true, 0n, ["primary", "secondary"], 7_000_000n],
  ["fund-8-usdc", true, 8_000_000n, [], 100_000n],
  ["base-1-usdc", true, 1_000_000n, ["primary"], 1_200_000n],
  ["step-up-2-usdc", true, 2_000_000n, ["primary", "secondary"], 1_200_000n],
  ["queue-4-usdc", true, 4_000_000n, ["primary", "secondary"], 1_500_000n],
  ["cancel-queue", true, 0n, ["primary", "secondary"], 1_500_000n],
  ["requeue-4-usdc", true, 4_000_000n, ["primary", "secondary"], 1_500_000n],
  ["early-reject", false, 4_000_000n, [], 0n],
  ["ready-execute", true, 4_000_000n, [], 500_000n],
] as const);

function validateInput(input: LocalPwaReviewInput): void {
  assertKeys(input, ["formatVersion", "profileId", "chainId", "safe", "guard", "delay", "usdc", "recipient", "primaryCredentialHash", "secondaryCredentialHash", "deploymentsHash", "policyHash", "topologyReportHash", "observer", "deadline"], "localhost review input");
  if (input.formatVersion !== 1 || input.profileId !== "local" || input.chainId !== SEPOLIA_CHAIN_ID) throw new Error("localhost review profile identity mismatch");
  for (const [value, label] of [[input.safe, "safe"], [input.guard, "guard"], [input.delay, "delay"], [input.usdc, "usdc"], [input.recipient, "recipient"]] as const) if (!isAddress(value) || getAddress(value) !== value) throw new Error(`${label} must be a canonical address`);
  if (!same(input.usdc, SEPOLIA_USDC_ADDRESS) || !same(input.recipient, PWA_RECIPIENT)) throw new Error("localhost review token or recipient differs from the fixed profile");
  for (const [value, label] of [[input.primaryCredentialHash, "primary credential"], [input.secondaryCredentialHash, "secondary credential"], [input.deploymentsHash, "deployments"], [input.policyHash, "policy"], [input.topologyReportHash, "topology"]] as const) assertHash(value, label);
  assertKeys(input.observer, ["processId", "executableHash", "sources", "confirmations"], "localhost observer");
  if (!PROCESS_ID.test(input.observer.processId)) throw new Error("observer process identity is invalid");
  assertHash(input.observer.executableHash, "observer executable hash");
  if (!Array.isArray(input.observer.sources) || input.observer.sources.length !== 2 || input.observer.sources.some((source) => typeof source !== "string" || !source) || input.observer.sources[0] === input.observer.sources[1]) throw new Error("two independent observer sources are required");
  if (!Number.isInteger(input.observer.confirmations) || input.observer.confirmations < 1) throw new Error("observer confirmations are invalid");
  if (!Number.isFinite(Date.parse(input.deadline))) throw new Error("localhost review deadline is invalid");
}

export function createLocalPwaReview(input: LocalPwaReviewInput): LocalPwaReview {
  validateInput(input);
  const actions = Object.freeze(ACTION_BLUEPRINTS.map(([id, broadcast, amount, roles, gas], index) => Object.freeze({
    id, ordinal: index + 1, broadcast, amount: amount.toString(), requiredApprovals: Object.freeze([...roles]) as readonly ("primary" | "secondary")[],
    maxGas: gas.toString(), maxFeePerGas: broadcast ? MAX_FEE_PER_GAS.toString() : "0", maxPriorityFeePerGas: broadcast ? MAX_PRIORITY_FEE_PER_GAS.toString() : "0",
  })));
  const maximumGas = actions.reduce((total, action) => total + BigInt(action.maxGas), 0n);
  const base = Object.freeze({ ...input, observer: Object.freeze({ ...input.observer, sources: Object.freeze([...input.observer.sources]) as readonly [string, string] }), scope: "sepolia-pwa-localhost-rehearsal" as const, authorization: "NONE" as const, principal: "8000000" as const, actions, maximumGas: maximumGas.toString(), maximumEthOutlayWei: (maximumGas * MAX_FEE_PER_GAS).toString(), expectedTerminal: Object.freeze({ safeUsdcBalance: "1000000" as const, recipientUsdcIncrease: "7000000" as const, queueDepth: "0" as const, baseSpent: "1000000" as const, instantSpent: "3000000" as const }) });
  return Object.freeze({ ...base, reviewHash: hash(base) });
}

function parseReview(value: unknown): LocalPwaReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("localhost review must be an object");
  const item = value as Record<string, unknown>;
  const { reviewHash, scope, authorization, principal, actions, maximumGas, maximumEthOutlayWei, expectedTerminal, ...rawInput } = item;
  assertHash(reviewHash, "localhost review hash");
  const rebuilt = createLocalPwaReview(rawInput as unknown as LocalPwaReviewInput);
  if (scope !== rebuilt.scope || authorization !== "NONE" || principal !== rebuilt.principal || canonical(actions) !== canonical(rebuilt.actions) || maximumGas !== rebuilt.maximumGas || maximumEthOutlayWei !== rebuilt.maximumEthOutlayWei || canonical(expectedTerminal) !== canonical(rebuilt.expectedTerminal) || !same(reviewHash, rebuilt.reviewHash)) throw new Error("localhost review content or hash mismatch");
  return rebuilt;
}

export function writeLocalPwaReviewPackage(reviewInput: LocalPwaReview, outputDirectory: string): Readonly<{ formatVersion: 1; scope: "sepolia-pwa-localhost-review-package"; reviewHash: Hex; sha256: Hex }> {
  const review = parseReview(reviewInput);
  if (!isAbsolute(outputDirectory) || existsSync(outputDirectory)) throw new Error("localhost review output must be a new absolute directory");
  const bytes = `${canonical(review)}\n`;
  const manifest = Object.freeze({ formatVersion: 1 as const, scope: "sepolia-pwa-localhost-review-package" as const, reviewHash: review.reviewHash, sha256: `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex });
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  writeFileSync(join(outputDirectory, "review.json"), bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(join(outputDirectory, "manifest.json"), `${canonical(manifest)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return manifest;
}

function approvalBase(review: LocalPwaReview, actionId: LocalPwaActionId, adapterHash: Hex, expiresAt: string) {
  return Object.freeze({ formatVersion: 1 as const, scope: "sepolia-pwa-localhost-one-action" as const, reviewHash: review.reviewHash, actionId, adapterHash, expiresAt });
}

export function loadLocalPwaApproval(reviewInput: LocalPwaReview, value: unknown): LocalPwaApproval {
  const review = parseReview(reviewInput);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("localhost approval must be an object");
  const item = value as Record<string, unknown>;
  assertKeys(item, ["formatVersion", "scope", "reviewHash", "actionId", "adapterHash", "expiresAt", "approvalHash"], "localhost approval");
  if (item.formatVersion !== 1 || item.scope !== "sepolia-pwa-localhost-one-action" || item.reviewHash !== review.reviewHash || typeof item.actionId !== "string" || !LOCAL_PWA_ACTION_IDS.includes(item.actionId as LocalPwaActionId) || typeof item.expiresAt !== "string" || !Number.isFinite(Date.parse(item.expiresAt))) throw new Error("localhost approval identity is invalid");
  assertHash(item.adapterHash, "localhost approval adapter hash"); assertHash(item.approvalHash, "localhost approval hash");
  const base = approvalBase(review, item.actionId as LocalPwaActionId, item.adapterHash, item.expiresAt);
  if (!same(item.approvalHash, hash(base))) throw new Error("localhost approval hash mismatch");
  const result = Object.freeze({ ...base, approvalHash: item.approvalHash }); approved.add(result); return result;
}

export function createLocalPwaApprovalForTestsOnly(review: LocalPwaReview, actionId: LocalPwaActionId, adapterHash: Hex): LocalPwaApproval {
  if (process.env.NODE_ENV !== "test" && process.env.HARDHAT_NETWORK !== "hardhat") throw new Error("test-only localhost approval is disabled");
  const base = approvalBase(parseReview(review), actionId, adapterHash, "2026-11-01T11:00:00.000Z");
  return loadLocalPwaApproval(review, { ...base, approvalHash: hash(base) });
}

function initialJournal(review: LocalPwaReview): LocalPwaJournal { return Object.freeze({ formatVersion: 1, chainId: SEPOLIA_CHAIN_ID, reviewHash: review.reviewHash, actions: Object.freeze(LOCAL_PWA_ACTION_IDS.map((id) => Object.freeze({ id, status: "planned" as const }))) }); }

function parseJournal(value: unknown, review: LocalPwaReview): LocalPwaJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("localhost journal malformed");
  const item = value as Record<string, unknown>; assertKeys(item, ["formatVersion", "chainId", "reviewHash", "actions"], "localhost journal");
  if (item.formatVersion !== 1 || item.chainId !== SEPOLIA_CHAIN_ID || item.reviewHash !== review.reviewHash || !Array.isArray(item.actions) || item.actions.length !== LOCAL_PWA_ACTION_IDS.length) throw new Error("localhost journal identity mismatch");
  const actions = item.actions.map((raw, index): JournalAction => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("localhost journal action malformed");
    const action = raw as Record<string, unknown>;
    const allowed = ["id", "status", "transactionHash", "attemptHash", "blockNumber", "blockHash", "observerRecordHash", "proofHash"];
    if (Object.keys(action).some((key) => !allowed.includes(key)) || action.id !== LOCAL_PWA_ACTION_IDS[index] || !["planned", "pending", "confirmed", "reverted", "proved"].includes(String(action.status))) throw new Error("localhost journal action identity mismatch");
    for (const key of ["transactionHash", "attemptHash", "blockHash", "observerRecordHash", "proofHash"] as const) if (action[key] !== undefined) assertHash(action[key], `localhost journal ${key}`);
    if (action.blockNumber !== undefined) decimal(action.blockNumber, "localhost journal block number");
    if (action.status === "pending" && (!action.transactionHash || !action.attemptHash)) throw new Error("localhost pending action lacks durable hash");
    if (action.status === "confirmed" && (!action.transactionHash || !action.blockNumber || !action.blockHash || !action.observerRecordHash)) throw new Error("localhost confirmed action lacks canonical observer evidence");
    if (action.status === "proved" && (!action.proofHash || !action.blockNumber || !action.blockHash)) throw new Error("localhost proof action lacks evidence");
    return Object.freeze(action as unknown as JournalAction);
  });
  let open = false;
  for (const action of actions) {
    if (action.status === "planned" || action.status === "pending") open = true;
    else if (open) throw new Error("localhost journal contains out-of-order terminal progress");
  }
  return Object.freeze({ formatVersion: 1, chainId: SEPOLIA_CHAIN_ID, reviewHash: review.reviewHash, actions: Object.freeze(actions) });
}

export function createLocalPwaJournalStore(path: string, reviewInput: LocalPwaReview): LocalPwaJournalStore {
  const review = parseReview(reviewInput);
  if (!isAbsolute(path)) throw new Error("localhost journal path must be absolute");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`; let lock: number | undefined;
  try { lock = openSync(lockPath, "wx", 0o600); writeFileSync(lock, `${process.pid}\n`); fsyncSync(lock); } catch { throw new Error("localhost journal writer lock unavailable"); }
  let current = existsSync(path) ? parseJournal(JSON.parse(readFileSync(path, "utf8")), review) : initialJournal(review);
  const persist = (journal: LocalPwaJournal): void => {
    if (lock === undefined) throw new Error("localhost journal writer lock is closed");
    const next = parseJournal(journal, review);
    current.actions.forEach((prior, index) => {
      const candidate = next.actions[index];
      if (prior.id !== candidate.id) throw new Error("localhost journal action identity changed");
      const transitions: Record<JournalAction["status"], readonly JournalAction["status"][]> = { planned: ["planned", "pending", "proved"], pending: ["pending", "confirmed", "reverted"], confirmed: ["confirmed"], reverted: ["reverted"], proved: ["proved"] };
      if (!transitions[prior.status].includes(candidate.status)) throw new Error("localhost journal action status regressed");
      if (prior.status !== "planned" && canonical(prior) !== canonical(candidate) && prior.status !== "pending") throw new Error("localhost terminal evidence changed");
      if (prior.status === "pending" && candidate.transactionHash !== prior.transactionHash) throw new Error("localhost pending transaction hash changed");
    });
    const changed = current.actions.flatMap((action, index) => canonical(action) === canonical(next.actions[index]) ? [] : [index]);
    if (changed.length > 1) throw new Error("localhost journal save may advance only one action");
    const temporary = `${path}.${process.pid}.tmp`; const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${canonical(next)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path); const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    current = next;
  };
  const close = (): void => { if (lock === undefined) return; closeSync(lock); lock = undefined; unlinkSync(lockPath); };
  return Object.freeze({ load: () => current, save: persist, close });
}

function assertReceipt(receipt: LocalPwaReceiptEvidence, expectedHash: Hex): void {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("localhost receipt evidence is missing");
  assertKeys(receipt, receipt.status === "success" ? ["status", "transactionHash", "blockNumber", "blockHash", "observerRecordHash"] : ["status", "transactionHash", "blockNumber", "blockHash"], "localhost receipt evidence");
  if (!same(receipt.transactionHash, expectedHash) || (receipt.status !== "success" && receipt.status !== "reverted")) throw new Error("localhost receipt identity mismatch");
  decimal(receipt.blockNumber, "localhost receipt block number"); assertHash(receipt.blockHash, "localhost receipt block hash");
  if (receipt.status === "success") assertHash(receipt.observerRecordHash, "localhost observer record hash");
}

export async function executeLocalPwaAction(input: Readonly<{
  mode: "submit-one";
  review: LocalPwaReview;
  approval: LocalPwaApproval;
  store: LocalPwaJournalStore;
  adapter: LocalPwaActionAdapter;
  liveSubmit: string | undefined;
  now?: Date;
}> | Readonly<{
  mode: "resume-one";
  review: LocalPwaReview;
  store: LocalPwaJournalStore;
  adapter: LocalPwaResumeAdapter;
  now?: Date;
}>): Promise<Readonly<{ actionId: LocalPwaActionId; status: "pending" | "confirmed" | "reverted" | "proved" }>> {
  const review = parseReview(input.review); const journal = input.store.load();
  if (journal.reviewHash !== review.reviewHash) throw new Error("localhost journal does not match review");
  if (input.mode === "resume-one") {
    assertPlainCapability(input.adapter, ["reconcile"], "resume capability");
    const pending = journal.actions.filter((action) => action.status === "pending");
    if (pending.length !== 1 || !pending[0].transactionHash) throw new Error("resume-one requires exactly one durable pending hash");
    const receipt = await input.adapter.reconcile(pending[0].transactionHash);
    if (!receipt) return Object.freeze({ actionId: pending[0].id, status: "pending" });
    assertReceipt(receipt, pending[0].transactionHash);
    const index = LOCAL_PWA_ACTION_IDS.indexOf(pending[0].id);
    const actions = [...journal.actions]; actions[index] = Object.freeze({ ...pending[0], status: receipt.status === "success" ? "confirmed" : "reverted", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, ...(receipt.observerRecordHash ? { observerRecordHash: receipt.observerRecordHash } : {}) });
    input.store.save({ ...journal, actions });
    return Object.freeze({ actionId: pending[0].id, status: receipt.status === "success" ? "confirmed" : "reverted" });
  }

  assertPlainCapability(input.adapter, ["prepare", "broadcast", "proveRejection"], "submit capability");
  if (!approved.has(input.approval) || input.approval.reviewHash !== review.reviewHash) throw new Error("reviewed one-action approval is required");
  if (journal.actions.some((action) => action.status === "reverted")) throw new Error("localhost rehearsal stopped after a reverted action");
  const index = journal.actions.findIndex((action) => action.status === "planned" || action.status === "pending");
  if (index < 0 || journal.actions[index].status === "pending") throw new Error("next action is pending or rehearsal is complete");
  const action = review.actions[index];
  if (input.approval.actionId !== action.id) throw new Error("approval does not match the next action");
  const now = input.now ?? new Date();
  if (now.getTime() > Date.parse(input.approval.expiresAt) || now.getTime() > Date.parse(review.deadline)) throw new Error("localhost one-action approval or review expired");
  if (!action.broadcast) {
    const proof = await input.adapter.proveRejection(action, review); assertKeys(proof, ["proofHash", "blockNumber", "blockHash"], "localhost rejection proof"); assertHash(proof.proofHash, "localhost proof hash"); decimal(proof.blockNumber, "localhost proof block number"); assertHash(proof.blockHash, "localhost proof block hash");
    const actions = [...journal.actions]; actions[index] = Object.freeze({ id: action.id, status: "proved", ...proof }); input.store.save({ ...journal, actions }); return Object.freeze({ actionId: action.id, status: "proved" });
  }
  if (input.liveSubmit !== "YES") throw new Error("submit-one requires exact PWA_LOCAL_SUBMIT=YES");
  const prepared = await input.adapter.prepare(action, review); assertKeys(prepared, ["actionId", "transactionHash", "attemptHash"], "prepared localhost action");
  if (prepared.actionId !== action.id) throw new Error("prepared action identity mismatch"); assertHash(prepared.transactionHash, "prepared transaction hash"); assertHash(prepared.attemptHash, "prepared attempt hash");
  const actions = [...journal.actions]; actions[index] = Object.freeze({ id: action.id, status: "pending", transactionHash: prepared.transactionHash, attemptHash: prepared.attemptHash }); input.store.save({ ...journal, actions });
  const receipt = await input.adapter.broadcast(prepared); assertReceipt(receipt, prepared.transactionHash);
  const after = input.store.load(); const updated = [...after.actions]; updated[index] = Object.freeze({ ...after.actions[index], status: receipt.status === "success" ? "confirmed" : "reverted", blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, ...(receipt.observerRecordHash ? { observerRecordHash: receipt.observerRecordHash } : {}) }); input.store.save({ ...after, actions: updated });
  return Object.freeze({ actionId: action.id, status: receipt.status === "success" ? "confirmed" : "reverted" });
}

function readJson(path: string): unknown { if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("input path must be an existing absolute regular non-symlink file"); return JSON.parse(readFileSync(path, "utf8")); }
async function adapterModule(path: string, mode: "submit-one" | "resume-one", review: LocalPwaReview): Promise<Readonly<{ adapter: LocalPwaActionAdapter | LocalPwaResumeAdapter; executableHash: Hex }>> {
  if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("adapter path must be an existing absolute regular non-symlink file");
  const executableHash = `0x${createHash("sha256").update(readFileSync(path)).digest("hex")}` as Hex;
  const module = await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
  if (Object.keys(module).length !== 1 || typeof module.createLocalPwaAdapter !== "function") throw new Error("adapter module must export only createLocalPwaAdapter");
  const adapter = await (module.createLocalPwaAdapter as (input: Readonly<{ mode: string; review: LocalPwaReview }>) => Promise<LocalPwaActionAdapter | LocalPwaResumeAdapter>)({ mode, review });
  return Object.freeze({ adapter, executableHash });
}

export async function runLocalPwaCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [mode, ...rest] = args;
  if (mode === "review") {
    if (rest.length !== 2) throw new Error("usage: pwa:rehearse:local review <absolute-input.json> <new-output-directory>");
    const review = createLocalPwaReview(readJson(rest[0]) as LocalPwaReviewInput); const manifest = writeLocalPwaReviewPackage(review, rest[1]); process.stdout.write(`${manifest.reviewHash}\n`); return;
  }
  if (mode !== "submit-one" && mode !== "resume-one") throw new Error("pwa:rehearse:local mode must be review, submit-one, or resume-one");
  const expected = mode === "submit-one" ? 4 : 3; if (rest.length !== expected) throw new Error(`usage: pwa:rehearse:local ${mode} <review.json>${mode === "submit-one" ? " <approval.json>" : ""} <journal.json> <adapter.ts>`);
  const review = parseReview(readJson(rest[0])); const approvalPath = mode === "submit-one" ? rest[1] : undefined; const journalPath = rest[mode === "submit-one" ? 2 : 1]; const adapterPath = rest[mode === "submit-one" ? 3 : 2];
  if (mode === "resume-one" && ["PWA_LOCAL_SUBMIT", "PRIVATE_KEY", "MNEMONIC", "PASSKEY_MATERIAL", "SAFE_SIGNATURES"].some((key) => env[key])) throw new Error("resume-one rejects signing or broadcast authority environment");
  const loaded = await adapterModule(adapterPath, mode, review); const store = createLocalPwaJournalStore(journalPath, review);
  try {
    if (mode === "submit-one") {
      const approval = loadLocalPwaApproval(review, readJson(approvalPath!)); if (!same(approval.adapterHash, loaded.executableHash)) throw new Error("approval does not bind the adapter executable");
      const result = await executeLocalPwaAction({ mode, review, approval, store, adapter: loaded.adapter as LocalPwaActionAdapter, liveSubmit: env.PWA_LOCAL_SUBMIT }); process.stdout.write(`${canonical(result)}\n`);
    } else {
      const result = await executeLocalPwaAction({ mode, review, store, adapter: loaded.adapter as LocalPwaResumeAdapter }); process.stdout.write(`${canonical(result)}\n`);
    }
  } finally { store.close(); }
}

if (require.main === module) runLocalPwaCli(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "localhost PWA rehearsal failed"}\n`); process.exitCode = 1; });
