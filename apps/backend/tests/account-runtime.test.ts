import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { AccountStore } from "../src/account-store";
import { createAccountGatewayForTestsOnly } from "../src/account-runtime";
import { loadBackendConfig } from "../src/config";
const H = `0x${"12".repeat(32)}` as const;
const address = (n: number) =>
  `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "multi-runtime-")),
    config = loadBackendConfig({
      BACKEND_PROFILE: "local",
      BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      BACKEND_RPC_URL: "https://unused.invalid",
      BACKEND_JOURNAL_PATH: join(dir, "old-s.json"),
      BACKEND_PROVISIONING_JOURNAL_PATH: join(dir, "old-p.json"),
      BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(dir, "old-r"),
    });
  const store = new AccountStore(config);
  return { config, store };
}
function signer(id: string, role: "primary" | "secondary", n: number) {
  return {
    id,
    role,
    publicKey: Uint8Array.of(n),
    x: BigInt(n),
    y: BigInt(n + 1),
    counter: 0,
  };
}
function ready(store: AccountStore) {
  const a = store.createAccount();
  store.storeCredential(a.id, signer(a.id + "-p", "primary", 1));
  store.storeCredential(a.id, signer(a.id + "-s", "secondary", 3));
  return a;
}
function journal(
  path: string,
  config: ReturnType<typeof loadBackendConfig>,
  pending = false,
) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      chainId: 11155111,
      funder: privateKeyToAccount(config.relayPrivateKey).address,
      entries: Array.from({ length: pending ? 1 : 7 }, (_, n) => ({
        id: `pwa-${n}`,
        intentHash: H,
        transactionHash: H,
        nonce: n,
        reserved: "0",
        status: pending ? "pending" : "success",
        ...(pending
          ? {}
          : {
              receipt: {
                transactionHash: H,
                blockNumber: "1",
                blockHash: H,
                status: "success",
                gasUsed: "1",
                effectiveGasPrice: "1",
              },
            }),
      })),
    }),
  );
}
describe("account runtime and shared payer", () => {
  it("serializes different account deployment plans and scopes active submissions to sessions", async () => {
    const { store, config } = fixture();
    try {
      let active = 0,
        max = 0,
        next = 10;
      const provision = vi.fn(async (c: any) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 10));
        journal(c.provisioningJournalPath, config);
        active--;
        const response = {
          chainId: 11155111 as const,
          safe: address(next++),
          guard: address(2),
          delay: address(3),
          primaryPasskey: address(4),
          secondaryPasskey: address(5),
          usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const,
          evidence: {
            setupTransactionHash: H,
            verificationReportHash: H,
            deploymentsHash: H,
            policyHash: H,
          },
        };
        return { response, verified: {} as never };
      });
      const gateway = createAccountGatewayForTestsOnly(config, store, {
        provisioner: async (c) => ({ provision: () => provision(c) }),
        runtime: () =>
          ({
            prepare: async ({ request }: any) => ({
              id: request.idempotencyKey,
              requestHash: H,
              safeTxHash: H,
              kind: "base-transfer",
              requiredApprovals: ["primary"],
              publicRequest: request,
            }),
            revalidate: async () => {},
            deriveOuterHash: async () => H,
            broadcast: async () => H,
            reconcile: async () => undefined,
          }) as never,
      });
      const a = ready(store),
        b = ready(store);
      const [one, two] = await Promise.all([
        gateway.provision(a.id),
        gateway.provision(b.id),
      ]);
      expect(one.safe).not.toBe(two.safe);
      expect(max).toBe(1);
      const session = store.createSession(a.id, true),
        other = store.createSession(a.id, true);
      await gateway.prepare(a.id, session.id, {
        kind: "transfer",
        recipient: address(8),
        amount: 1n,
        idempotencyKey: "same",
      });
      await expect(
        gateway.submit(a.id, other.id, "same", {
          role: "primary",
          assertion: {},
        }),
      ).rejects.toThrow(/another session/);
      expect(await gateway.status(a.id, "same")).toMatchObject({ id: "same" });
      await expect(gateway.status(b.id, "same")).rejects.toThrow();
    } finally {
      store.close();
    }
  });
  it("blocks a second account before planning when another journal has an unresolved hash", async () => {
    const { store, config } = fixture();
    try {
      const a = ready(store),
        b = ready(store);
      store.markProvisioning(a.id, "provisioning");
      journal(a.config.provisioningJournalPath, config, true);
      const factory = vi.fn();
      const gateway = createAccountGatewayForTestsOnly(config, store, {
        provisioner: factory,
        runtime: vi.fn(),
      });
      await expect(gateway.provision(b.id)).rejects.toThrow(
        /unresolved|incomplete/,
      );
      expect(factory).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});
