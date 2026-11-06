import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store";
import { loadBackendConfig } from "../src/config";
const stores: AccountStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function config() {
  const root = mkdtempSync(join(tmpdir(), "vault-accounts-"));
  return loadBackendConfig({
    BACKEND_PROFILE: "local",
    BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    BACKEND_RPC_URL: "https://unused.invalid",
    BACKEND_JOURNAL_PATH: join(root, "legacy-submit.json"),
    BACKEND_PROVISIONING_JOURNAL_PATH: join(root, "legacy-provision.json"),
    BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(root, "legacy-reviews"),
  });
}
const credential = (
  id: string,
  role: "primary" | "secondary" = "primary",
  n = 1,
) => ({
  id,
  role,
  publicKey: Uint8Array.of(n),
  counter: 0,
  x: BigInt(n),
  y: BigInt(n + 1),
});
const open = (c = config(), now?: () => number) => {
  const s = new AccountStore(c, now);
  stores.push(s);
  return s;
};
describe("persistent multi-user account store", () => {
  it("persists arbitrary account counts and isolates credentials across reopen", () => {
    const c = config(),
      s = open(c);
    const ids = Array.from({ length: 130 }, () => s.createAccount().id);
    expect(new Set(ids).size).toBe(130);
    const a = s.account(ids[0]!)!;
    s.storeCredential(a.id, credential("first"), a.userHandle);
    s.close();
    stores.pop();
    const next = open(c);
    expect([...next.accounts()].length).toBe(130);
    expect(next.credential("first")?.accountId).toBe(a.id);
    expect(next.credentials(ids[1]!).length).toBe(0);
    expect(() => next.account("../../escape")).toThrow();
  });
  it("rejects role overwrite, shared credentials and equal role keys", () => {
    const s = open(),
      a = s.createAccount(),
      b = s.createAccount();
    s.storeCredential(a.id, credential("p"), a.userHandle);
    expect(() => s.storeCredential(a.id, credential("p2"))).toThrow();
    expect(() => s.storeCredential(b.id, credential("p"))).toThrow();
    expect(() =>
      s.storeCredential(a.id, credential("s", "secondary")),
    ).toThrow();
    s.storeCredential(a.id, credential("s", "secondary", 3));
    expect(s.credentials(a.id).length).toBe(2);
  });
  it("hashes tokens, expires/revokes sessions and consumes challenges once", () => {
    let now = 1000;
    const s = open(config(), () => now),
      a = s.createAccount();
    const session = s.createSession(a.id, true);
    expect(s.session(session.token)?.accountId).toBe(a.id);
    const ch = s.createChallenge(session.id, "login");
    expect(s.consumeChallenge(session.id, ch.id, "login").challenge).toBe(
      ch.challenge,
    );
    expect(() => s.consumeChallenge(session.id, ch.id, "login")).toThrow();
    const other = s.createSession(a.id, true);
    const cross = s.createChallenge(session.id, "login");
    expect(() => s.consumeChallenge(other.id, cross.id, "login")).toThrow();
    expect(
      readFileSync(s.databasePath).includes(Buffer.from(session.token)),
    ).toBe(false);
    s.revokeSession(session.token);
    expect(s.session(session.token)).toBeUndefined();
    now += 31 * 60_000;
    expect(s.session(other.token)).toBeUndefined();
  });
  it("updates counters atomically and claims active submissions per session", () => {
    const s = open(),
      a = s.createAccount(),
      b = s.createAccount();
    s.storeCredential(a.id, credential("p"));
    s.updateCounter("p", 0, 2);
    expect(() => s.updateCounter("p", 0, 3)).toThrow();
    s.claimSubmission(a.id, "same", "one");
    s.claimSubmission(b.id, "same", "two");
    expect(() => s.assertSubmissionOwner(a.id, "same", "two")).toThrow();
    s.assertSubmissionOwner(b.id, "same", "two");
    expect(() => s.claimSubmission(a.id, "same", "two")).toThrow();
  });
});

it("rejects unknown schemas and managed-directory escapes without replacing execution journals", () => {
  const c = config(),
    s = open(c),
    a = s.createAccount(),
    path = s.databasePath;
  const outside = mkdtempSync(join(tmpdir(), "account-escape-"));
  symlinkSync(outside, join(s.dataDirectory, a.id));
  expect(() => s.account(a.id)).toThrow(/escapes/);
  s.close();
  stores.pop();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=99");
  db.close();
  expect(() => open(c)).toThrow(/schema/);
  const collision = config();
  expect(() =>
    open({ ...collision, accountDatabasePath: collision.journalPath }),
  ).toThrow(/journal/);
});

it("cannot hide retained account evidence by losing its registry or account row", () => {
  const c = config(),
    s = open(c),
    a = s.createAccount(),
    path = s.databasePath;
  mkdirSync(dirname(a.config.provisioningJournalPath), { recursive: true });
  writeFileSync(a.config.provisioningJournalPath, "{}");
  const db = new DatabaseSync(path);
  db.prepare("DELETE FROM accounts WHERE id=?").run(a.id);
  db.close();
  expect(() => s.validateEvidenceInventory()).toThrow(/registry/);
  s.close();
  stores.pop();
  unlinkSync(path);
  expect(() => open(c)).toThrow(/registry/);
});
it("consumes an accepted assertion fingerprint atomically with its counter", () => {
  const s = open(),
    a = s.createAccount();
  s.storeCredential(a.id, credential("p"));
  s.consumeApproval(a.id, "p", 0, 0, "first");
  expect(() => s.consumeApproval(a.id, "p", 0, 0, "first")).toThrow(
    /used|UNIQUE/,
  );
  expect(s.credential("p")?.counter).toBe(0);
});
