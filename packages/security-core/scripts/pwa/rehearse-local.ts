import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
  if (same(input.primaryCredentialHash, input.secondaryCredentialHash)) throw new Error("primary and secondary credential bindings must differ");
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

function readJson(path: string): unknown { if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("input path must be an existing absolute regular non-symlink file"); return JSON.parse(readFileSync(path, "utf8")); }

export async function runLocalPwaCli(args: readonly string[]): Promise<void> {
  const [mode, ...rest] = args;
  if (mode === "review") {
    if (rest.length !== 2) throw new Error("usage: pwa:rehearse:local review <absolute-input.json> <new-output-directory>");
    const review = createLocalPwaReview(readJson(rest[0]) as LocalPwaReviewInput); const manifest = writeLocalPwaReviewPackage(review, rest[1]); process.stdout.write(`${manifest.reviewHash}\n`); return;
  }
  if (mode === "submit-one" || mode === "resume-one") throw new Error(`${mode} is disabled until a fixed in-repository transaction validator and observer-record loader are reviewed`);
  throw new Error("pwa:rehearse:local mode must be review");
}

if (require.main === module) runLocalPwaCli(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "localhost PWA rehearsal failed"}\n`); process.exitCode = 1; });
