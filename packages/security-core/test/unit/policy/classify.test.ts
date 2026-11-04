import { expect } from "chai";
import { encodeFunctionData, parseAbi, toFunctionSelector, type Address } from "viem";
import {
  assertValidVaultPolicy,
  type AssetPolicy,
  type AssetSpendState,
  type VaultPolicy,
} from "../../../src/config/policy";
import { classifyAction, type ClassifiableAction } from "../../../src/policy/classify";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const SAFE = "0x0000000000000000000000000000000000000001" as Address;
const PASSKEY = "0x0000000000000000000000000000000000000002" as Address;
const BURNER = "0x0000000000000000000000000000000000000003" as Address;
const LEGACY_RECOVERY_TARGET = "0x0000000000000000000000000000000000004" as Address;
const DELAY = "0x0000000000000000000000000000000000000005" as Address;
const YUBIKEY = "0x0000000000000000000000000000000000000006" as Address;
const TOKEN = "0x0000000000000000000000000000000000000010" as Address;
const RECIPIENT = "0x0000000000000000000000000000000000000020" as Address;
const OTHER = "0x0000000000000000000000000000000000000021" as Address;
const PERIOD = 86_400n;

const asset: AssetPolicy = {
  token: TOKEN,
  basePerTransaction: 100n,
  stepUpPerTransaction: 500n,
  baseDailyLimit: 1_000n,
  instantDailyLimit: 2_000n,
  baseRecipientMode: "allowlisted",
  recipients: [RECIPIENT],
};
const nativeAsset: AssetPolicy = { ...asset, token: ZERO };

const policy: VaultPolicy = {
  chainId: 11155111,
  safe: SAFE,
  passkey: PASSKEY,
  ecdsaSecondary: BURNER,
  primary: PASSKEY,
  secondaries: [
    { address: YUBIKEY, role: "secondary", kind: "safe-contract", enabled: true },
    { address: BURNER, role: "secondary", kind: "ecdsa-extension", enabled: true },
  ],
  delay: DELAY,
  periodSeconds: 86_400,
  periodAnchor: 0n,
  cooldownSeconds: 86_400,
  expirationSeconds: 86_400,
  assets: [asset, nativeAsset],
};
const boundaryPolicy: VaultPolicy = {
  ...policy,
  assets: [{ ...asset, stepUpPerTransaction: 2_000n }],
};

const state: AssetSpendState = { window: 0n, baseSpent: 0n, instantSpent: 0n };
const transfer = (to: Address, value: bigint, overrides: Partial<ClassifiableAction> = {}): ClassifiableAction => ({
  to,
  value,
  data: "0x",
  operation: "call",
  signer: PASSKEY,
  ...overrides,
});
const tokenTransfer = (value: bigint, overrides: Partial<ClassifiableAction> = {}): ClassifiableAction => ({
  to: TOKEN,
  value: 0n,
  data: encodeFunctionData({ abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [RECIPIENT, value] }),
  operation: "call",
  signer: PASSKEY,
  ...overrides,
});

const tokenTransferTo = (recipient: Address, value: bigint, overrides: Partial<ClassifiableAction> = {}): ClassifiableAction =>
  tokenTransfer(value, {
    data: encodeFunctionData({ abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "transfer", args: [recipient, value] }),
    ...overrides,
  });

describe("classifyAction", () => {
  it("allows an unlisted valid USDC recipient only in the open base lane", () => {
    const openBasePolicy = {
      ...policy,
      assets: [{ ...asset, baseRecipientMode: "any-valid-address" }],
    } as VaultPolicy;

    expect(classifyAction(openBasePolicy, tokenTransferTo(OTHER, 100n), state, 1n)).to.equal("base");
    expect(classifyAction(openBasePolicy, tokenTransferTo(ZERO, 100n), state, 1n)).to.equal("blocked");
    expect(classifyAction(openBasePolicy, tokenTransferTo(OTHER, 101n), state, 1n, true)).to.equal("blocked");
    expect(classifyAction(openBasePolicy, tokenTransferTo(OTHER, 2_001n), state, 1n, true)).to.equal("blocked");
  });

  it("rejects a legacy asset policy without an explicit base recipient mode", () => {
    const { baseRecipientMode: _discarded, ...legacyAsset } = {
      ...asset,
      baseRecipientMode: "allowlisted",
    };
    expect(() => assertValidVaultPolicy({ ...policy, assets: [legacyAsset] as never })).to.throw();
  });

  it("classifies native and ERC-20 transfers across X and Y with cumulative state", () => {
    expect(classifyAction(policy, transfer(RECIPIENT, 100n), state, 1n)).to.equal("base");
    expect(classifyAction(policy, transfer(RECIPIENT, 101n, { secondaryApproved: true }), state, 1n)).to.equal("step-up");
    expect(classifyAction(policy, transfer(RECIPIENT, 2_001n), state, 1n)).to.equal("delayed");
    expect(classifyAction(policy, tokenTransfer(100n), state, 1n)).to.equal("base");
    expect(classifyAction(policy, tokenTransfer(101n, { secondaryApproved: true }), state, 1n)).to.equal("step-up");
  });

  it("uses remaining X and shared Y, including exact boundaries and reset windows", () => {
    expect(classifyAction(policy, transfer(RECIPIENT, 90n), { ...state, baseSpent: 100n, instantSpent: 100n }, 1n)).to.equal("base");
    expect(classifyAction(policy, transfer(RECIPIENT, 1n), { ...state, baseSpent: 1_000n, instantSpent: 1_000n }, 1n, true)).to.equal("step-up");
    expect(classifyAction(policy, transfer(RECIPIENT, 1n), { ...state, baseSpent: 1_000n, instantSpent: 2_000n }, 1n)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 100n), { ...state, window: 0n }, PERIOD + 1n)).to.equal("base");
  });

  it("places exact Y in step-up and values above Y in delayed", () => {
    expect(classifyAction(boundaryPolicy, tokenTransfer(2_000n), state, 1n, true)).to.equal("step-up");
    expect(classifyAction(boundaryPolicy, tokenTransfer(2_001n), state, 1n, true)).to.equal("delayed");
  });

  it("requires secondary approval for step-up and blocks per-transaction cap violations", () => {
    expect(classifyAction(policy, transfer(RECIPIENT, 101n), state, 1n, false)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 101n), state, 1n, true)).to.equal("step-up");
    expect(classifyAction(policy, transfer(RECIPIENT, 501n), state, 1n, true)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 2_001n), state, 1n, true)).to.equal("delayed");
  });

  it("fails closed for unsupported destinations, tokens, calldata, operations, and signers", () => {
    expect(classifyAction(policy, transfer(OTHER, 1n), state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, transfer(TOKEN, 1n), state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 1n, { operation: "delegatecall" }), state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 1n, { data: "0x12345678" }), state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, tokenTransfer(1n, { data: "0xa9059cbb00" }), state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 1n, { signer: BURNER }), state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, transfer(RECIPIENT, 1n, { operation: 2 as never }), state, 1n)).to.equal("blocked");
  });

  it("delays recognized transfer, Safe configuration, and Delay actions without a recovery-only target", () => {
    expect(classifyAction(policy, transfer(RECIPIENT, 2_001n, { secondaryApproved: true }), state, 1n)).to.equal("delayed");
    expect(classifyAction(policy, { ...transfer(SAFE, 0n), data: encodeFunctionData({ abi: parseAbi(["function setGuard(address)"]), functionName: "setGuard", args: [ZERO] }) }, state, 1n)).to.equal("delayed");
    expect(classifyAction(policy, { ...transfer(SAFE, 0n), data: encodeFunctionData({ abi: parseAbi(["function disableModule(address,address)"]), functionName: "disableModule", args: [ZERO, DELAY] }) }, state, 1n)).to.equal("delayed");
    expect(classifyAction(policy, { ...transfer(DELAY, 0n), data: "0x12345678" }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(LEGACY_RECOVERY_TARGET, 0n), data: "0x12345678" }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(DELAY, 0n), data: toFunctionSelector("skipExpired()") }, state, 1n)).to.equal("delayed");
    expect(classifyAction(policy, { ...transfer(LEGACY_RECOVERY_TARGET, 0n), data: toFunctionSelector("freeze()") }, state, 1n)).to.equal("blocked");
  });

  it("blocks delayed control actions carrying ETH", () => {
    const setGuard = encodeFunctionData({ abi: parseAbi(["function setGuard(address)"]), functionName: "setGuard", args: [ZERO] });
    expect(classifyAction(policy, { ...transfer(SAFE, 1n), data: setGuard }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(DELAY, 1n), data: toFunctionSelector("skipExpired()") }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(LEGACY_RECOVERY_TARGET, 1n), data: toFunctionSelector("freeze()") }, state, 1n)).to.equal("blocked");
  });

  it("blocks truncated, extra, malformed, and invalid-argument delayed calldata", () => {
    const validSetGuard = encodeFunctionData({ abi: parseAbi(["function setGuard(address)"]), functionName: "setGuard", args: [ZERO] });
    expect(classifyAction(policy, { ...transfer(SAFE, 0n), data: validSetGuard.slice(0, -2) as `0x${string}` }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(SAFE, 0n), data: `${validSetGuard}00` as `0x${string}` }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(SAFE, 0n), data: "0xe19a9dd9" }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(DELAY, 0n), data: `${toFunctionSelector("skipExpired()")}00` as `0x${string}` }, state, 1n)).to.equal("blocked");
    expect(classifyAction(policy, { ...transfer(DELAY, 0n), data: encodeFunctionData({ abi: parseAbi(["function executeNextTx(address,uint256,bytes,uint8)"]), functionName: "executeNextTx", args: [RECIPIENT, 1n, "0x", 1] }) }, state, 1n)).to.equal("blocked");
  });

  it("blocks inconsistent spend counters", () => {
    expect(classifyAction(policy, transfer(RECIPIENT, 1n), { ...state, baseSpent: 2n, instantSpent: 1n }, 1n)).to.equal("blocked");
  });

  it("rejects invalid policy invariants", () => {
    expect(() => assertValidVaultPolicy({ ...policy, periodAnchor: 1n })).to.throw();
    expect(() => assertValidVaultPolicy({ ...policy, assets: [{ ...asset, baseDailyLimit: 0n }] })).to.throw();
    expect(() => assertValidVaultPolicy({ ...policy, assets: [{ ...asset, instantDailyLimit: 1_000n }] })).to.throw();
    expect(() => assertValidVaultPolicy({ ...policy, ecdsaSecondary: PASSKEY })).to.throw();
    expect(() => assertValidVaultPolicy({ ...policy, assets: [{ ...asset, basePerTransaction: 1_001n }] })).to.throw();
    expect(() => assertValidVaultPolicy({ ...policy, recovery: LEGACY_RECOVERY_TARGET } as never)).to.throw("recovery");
  });

  it("validates the Option B primary plus configured secondary signer policy", () => {
    expect(() => assertValidVaultPolicy(policy)).to.not.throw();
    expect(() => assertValidVaultPolicy({ ...policy, primary: BURNER })).to.throw("primary");
    expect(() => assertValidVaultPolicy({ ...policy, secondaries: [] })).to.throw("secondary");
    expect(() => assertValidVaultPolicy({ ...policy, secondaries: [{ address: PASSKEY, role: "secondary", kind: "safe-contract", enabled: true }] })).to.throw("distinct");
    expect(() => assertValidVaultPolicy({ ...policy, secondaries: [{ address: YUBIKEY, role: "primary", kind: "safe-contract", enabled: true }] })).to.throw("role");
    expect(() => assertValidVaultPolicy({ ...policy, secondaries: [{ address: YUBIKEY, role: "secondary", kind: "unknown", enabled: true } as never] })).to.throw("kind");
    expect(() => assertValidVaultPolicy({ ...policy, secondaries: [{ address: YUBIKEY, role: "secondary", kind: "safe-contract", enabled: false }] })).to.throw("enabled");
  });
});
