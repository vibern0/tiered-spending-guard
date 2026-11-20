import { describe, expect, it } from "vitest";
import {
  assertLocal,
  parseRecord,
  classifyState,
  policyMatches,
} from "./wallet";

describe("static wallet fail-closed state", () => {
  it("refuses public chains and non-loopback endpoints", () => {
    expect(() =>
      assertLocal({
        chainId: 1,
        rpcUrl: "http://localhost:8545",
        bundlerUrl: "http://localhost:4337",
      }),
    ).toThrow();
    expect(() =>
      assertLocal({
        chainId: 31337,
        rpcUrl: "https://rpc.example",
        bundlerUrl: "http://localhost:4337",
      }),
    ).toThrow();
  });
  it("does not trust a persisted enabled flag", () => {
    expect(parseRecord('{"enabled":true}')).toBeNull();
    expect(classifyState(true, false, false)).toBe("blocked");
    expect(classifyState(true, true, false)).toBe("ordinary");
    expect(classifyState(true, false, true)).toBe("enabled");
    expect(classifyState(false, false, false)).toBe("undeployed");
  });
  it("checks actual limits and secondary, not just slots", () => {
    expect(
      policyMatches(
        [10n ** 19n, 3n * 10n ** 19n, 10n ** 19n, 3n * 10n ** 19n, 0],
        ["0x123", 0, true],
        "0x123",
      ),
    ).toBe(true);
    expect(
      policyMatches(
        [10n ** 19n, 3n * 10n ** 19n, 10n ** 19n, 4n * 10n ** 19n, 0],
        ["0x123", 0, true],
        "0x123",
      ),
    ).toBe(false);
    expect(
      policyMatches(
        [10n ** 19n, 3n * 10n ** 19n, 10n ** 19n, 3n * 10n ** 19n, 0],
        ["0x123", 0, false],
        "0x123",
      ),
    ).toBe(false);
  });
});

import { providerFields } from "./provider";
const sponsor = "0x0000000000000000000000000000000000000002";
it("rejects provider attempts to rewrite the signed action", () => {
  expect(() => providerFields({ sender: sponsor }, "gas", sponsor)).toThrow(
    "Unexpected provider field",
  );
  expect(() =>
    providerFields({ callData: "0x1234" }, "sponsor", sponsor),
  ).toThrow("Unexpected provider field");
  expect(() =>
    providerFields({ callGasLimit: "0x10000000" }, "gas", sponsor),
  ).toThrow("budget");
  expect(() =>
    providerFields({ paymaster: sponsor }, "sponsor", sponsor),
  ).toThrow("Incomplete");
});

import { vi } from "vitest";
import { Wallet, type WalletRecord, type Manifest } from "./wallet";
const address = "0x0000000000000000000000000000000000000002";
const hash = `0x${"11".repeat(32)}` as const;
function harness() {
  const persist = vi.fn();
  const manifest: Manifest = {
    entryPoint: "0x0000000000000000000000000000000000000001",
    hashes: {},
    singleton: address,
    proxyFactory: address,
    moduleSetup: address,
    standardModule: address,
    multiSend: address,
    multiSendCallOnly: address,
    createCall: address,
    signerFactory: address,
    verifier: address,
    recipient: address,
    token: sponsor,
    paymaster: sponsor,
    chainId: 31337,
    rpcUrl: "http://localhost:8545",
    bundlerUrl: "http://localhost:4337",
  };
  const wallet = new Wallet(manifest, persist, () => {});
  const record = {
    version: 1,
    chainId: 31337,
    safe: address,
    primary: {
      id: "credential",
      publicKey: `0x${"22".repeat(64)}`,
      signer: address,
    },
    salt: hash,
    initializer: "0x1234",
    pending: { hash, label: "activation" },
  } as WalletRecord;
  return { wallet, record, persist };
}
it("retains the durable hash after reload when inclusion is ambiguous", async () => {
  const { wallet, record, persist } = harness();
  vi.spyOn(wallet, "rpc").mockResolvedValue(null);
  await expect(wallet.reconcile(record)).rejects.toThrow("unresolved");
  expect(record.pending?.hash).toBe(hash);
  expect(persist).not.toHaveBeenCalled();
});
function confirmed(wallet: Wallet, success: boolean) {
  const receipt = {
    userOpHash: hash,
    sender: address,
    entryPoint: wallet.manifest.entryPoint,
    paymaster: sponsor,
    success,
    receipt: { blockHash: hash, transactionHash: hash },
  };
  Object.assign(wallet.manifest, { paymaster: sponsor });
  vi.spyOn(wallet.client, "getLogs").mockResolvedValue([
    { transactionHash: hash, args: { success } },
  ] as never);
  return vi.spyOn(wallet, "rpc").mockResolvedValue(receipt);
}
it("keeps the pending hash when an alleged receipt lacks a matching EntryPoint event", async () => {
  const { wallet, record, persist } = harness();
  confirmed(wallet, true);
  vi.mocked(wallet.client.getLogs).mockResolvedValue([]);
  await expect(wallet.reconcile(record)).rejects.toThrow("EntryPoint");
  expect(record.pending?.hash).toBe(hash);
  expect(persist).not.toHaveBeenCalled();
});
it("clears a reverted operation without presenting enabled", async () => {
  const { wallet, record, persist } = harness();
  confirmed(wallet, false);
  await expect(wallet.reconcile(record)).rejects.toThrow("reverted");
  expect(record.pending).toBeUndefined();
  expect(persist).toHaveBeenCalledOnce();
});
it("reconciles a confirmed operation on reload without another signature", async () => {
  const { wallet, record, persist } = harness();
  const rpc = confirmed(wallet, true);
  await wallet.reconcile(record);
  expect(record.pending).toBeUndefined();
  expect(persist).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledExactlyOnceWith("eth_getUserOperationReceipt", [
    hash,
  ]);
});
it("refuses a changed saved initializer before asking for a signature", async () => {
  const { wallet, record } = harness();
  Object.assign(wallet.manifest, {
    signerFactory: address,
    verifier: address,
    moduleSetup: address,
    standardModule: address,
    multiSend: address,
  });
  vi.spyOn(wallet, "read").mockResolvedValue(address);
  await expect(wallet.validateRecord(record)).rejects.toThrow(
    "initialization differs",
  );
});
it("refuses a duplicated secondary on resume", async () => {
  const { wallet, record } = harness();
  Object.assign(wallet.manifest, { signerFactory: address, verifier: address });
  record.secondary = { ...record.primary };
  vi.spyOn(wallet, "read").mockResolvedValue(address);
  await expect(wallet.validateRecord(record)).rejects.toThrow("distinct");
});
it("rejects missing and inconsistent RPC chain state", async () => {
  const { wallet } = harness();
  vi.spyOn(wallet.client, "getChainId").mockResolvedValue(1);
  await expect(wallet.preflight()).rejects.toThrow("chain changed");
});

it("refuses an installed policy whose token has no guarded route", async () => {
  const { wallet, record } = harness();
  record.secondary = { ...record.primary, id: "secondary", signer: sponsor };
  Object.assign(wallet.manifest, {
    recipient: "0x000000000000000000000000000000000000bEEF",
  });
  const values: Record<string, unknown> = {
    assetPolicy: [10n ** 19n, 3n * 10n ** 19n, 10n ** 19n, 3n * 10n ** 19n, 0],
    safeContractSecondary: [sponsor, 0, true],
    ecdsaSecondary: ["0x0000000000000000000000000000000000000000", 1, false],
    getConfiguredTokens: [wallet.manifest.token],
    getPolicyRecipients: [wallet.manifest.recipient],
    txCooldown: 120n,
    txExpiration: 600n,
    config: [
      record.safe,
      record.primary.signer,
      "0x0000000000000000000000000000000000000000",
      address,
      86400n,
      0n,
    ],
    frozen: false,
    maintenance: "0x0000000000000000000000000000000000000000",
    getRouteOnlyTargets: [],
    routeOnlyTarget: false,
  };
  vi.spyOn(wallet, "read").mockImplementation(async (_n, _a, f) => values[f]);
  vi.spyOn(wallet, "delayUpstream").mockResolvedValue(true);
  expect(
    await wallet.policy(record, {
      guard: { address },
      delay: { address },
    } as any),
  ).toBe(false);
  values.getRouteOnlyTargets = [wallet.manifest.token];
  values.routeOnlyTarget = true;
  expect(
    await wallet.policy(record, {
      guard: { address },
      delay: { address },
    } as any),
  ).toBe(true);
});

it("refuses to sign a token send from an ordinary Safe or to a different recipient", async () => {
  const { wallet, record } = harness();
  const inspect = vi.spyOn(wallet, "inspect").mockResolvedValue("ordinary");
  const submit = vi.spyOn(wallet, "submit");
  await expect(
    wallet.send(record, wallet.manifest.recipient, "1"),
  ).rejects.toThrow("Enable");
  inspect.mockResolvedValue("enabled");
  await expect(
    wallet.send(record, "0x0000000000000000000000000000000000000001", "1"),
  ).rejects.toThrow("approved");
  expect(submit).not.toHaveBeenCalled();
});
it("rejects a manifest that substitutes a different token implementation", async () => {
  const { wallet } = harness();
  vi.spyOn(wallet.client, "getChainId").mockResolvedValue(31337);
  wallet.manifest.hashes.token = hash;
  await expect(wallet.preflight()).rejects.toThrow("reviewed GLD");
});
