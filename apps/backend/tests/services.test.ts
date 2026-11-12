import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store";
import { loadBackendConfig } from "../src/config";
import { AccountService } from "../src/services/account-service";
import { TransactionService } from "../src/services/transaction-service";

function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "vault-services-"));
  const config = loadBackendConfig({
    BACKEND_PROFILE: "local",
    BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    BACKEND_RPC_URL: "https://unused.invalid",
    BACKEND_JOURNAL_PATH: join(root, "submissions.json"),
    BACKEND_PROVISIONING_JOURNAL_PATH: join(root, "provisioning.json"),
    BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(root, "reviews"),
  });
  return new AccountStore(config);
}

describe("backend services", () => {
  it("creates one unprivileged account session and projects its public metadata", async () => {
    const store = storeFixture();
    try {
      const service = new AccountService(store, {
        handlers: async () => {
          throw new Error("unverified account must not load runtime handlers");
        },
        submissionIds: async () => {
          throw new Error("unauthenticated account must not list submissions");
        },
      });

      const created = service.create();
      const projection = await service.project(created);

      expect(created.authenticated).toBe(false);
      expect(projection).toEqual({
        authenticated: false,
        csrfToken: created.csrfToken,
        account: {
          id: created.accountId,
          userHandle: store.account(created.accountId!)!.userHandle,
          state: "registering",
        },
      });
      expect([...store.accounts()]).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("keeps prepare, submit, and transaction lookup scoped to exact account and session", async () => {
    const service = new TransactionService({
      prepare: async (accountId, sessionId, body) => {
        if (accountId !== "account-a" || sessionId !== "session-a" || body !== "prepare-body")
          throw new Error("prepare scope changed");
        return { state: "prepared" };
      },
      submit: async (accountId, sessionId, id, body) => {
        if (
          accountId !== "account-a" ||
          sessionId !== "session-a" ||
          id !== "transaction-a" ||
          body !== "submit-body"
        )
          throw new Error("submit scope changed");
        return { state: "submitted" };
      },
      status: async (accountId, id) => {
        if (accountId !== "account-a" || id !== "transaction-a")
          throw new Error("lookup scope changed");
        return { state: "confirmed" };
      },
    });

    await expect(service.prepare("account-a", "session-a", "prepare-body")).resolves.toEqual({
      state: "prepared",
    });
    await expect(
      service.submit("account-a", "session-a", "transaction-a", "submit-body"),
    ).resolves.toEqual({ state: "submitted" });
    await expect(service.find("account-a", "transaction-a")).resolves.toEqual({
      state: "confirmed",
    });
  });
});
