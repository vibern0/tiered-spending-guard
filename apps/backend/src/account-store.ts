import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  opendirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { assertExternalBackendPath, type BackendConfig } from "./config";
import type { BackendPasskeyRole, StoredCredential } from "./webauthn";

export type AccountRecord = Readonly<{
  id: string;
  userHandle: string;
  state: "registering" | "queued" | "provisioning" | "verified";
  legacy: boolean;
  config: BackendConfig;
}>;
export type AccountCredential = StoredCredential &
  Readonly<{ accountId: string; userHandle?: string }>;
export type AccountSession = Readonly<{
  id: string;
  accountId?: string;
  authenticated: boolean;
  csrfToken: string;
}>;
export type NewAccountSession = AccountSession & Readonly<{ token: string }>;
export type AccountChallenge = Readonly<{
  id: string;
  challenge: string;
  role?: BackendPasskeyRole;
}>;
type Row = Record<string, string | number | Uint8Array | null>;
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const csrf = (v: string) => hash(`vault-csrf:${v}`);
const identifier = (v: string) => {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(v))
    throw new Error("invalid account identifier");
};

/** Metadata is not chain verification or signer authority. Execution journals remain authoritative. */
export class AccountStore {
  readonly databasePath: string;
  readonly dataDirectory: string;
  private readonly db: DatabaseSync;
  private inTransaction = false;
  constructor(
    private readonly base: BackendConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.databasePath = assertExternalBackendPath(
      base.accountDatabasePath ??
        `${base.provisioningJournalPath}.accounts.sqlite`,
      "account database",
    );
    if (
      [base.journalPath, base.provisioningJournalPath].includes(
        this.databasePath,
      )
    )
      throw new Error("account database cannot replace an execution journal");
    this.dataDirectory = assertExternalBackendPath(
      `${this.databasePath}.data`,
      "account data directory",
    );
    if (!existsSync(this.databasePath)) {
      const retained = existsSync(this.dataDirectory)
        ? opendirSync(this.dataDirectory)
        : undefined;
      try {
        if (
          retained?.readSync() ||
          existsSync(`${this.databasePath}-wal`) ||
          existsSync(`${this.databasePath}-shm`)
        )
          throw new Error(
            "account registry missing with retained execution evidence",
          );
      } finally {
        retained?.closeSync();
      }
    }
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(this.dataDirectory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.databasePath))
      closeSync(openSync(this.databasePath, "wx", 0o600));
    chmodSync(this.databasePath, 0o600);
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
      );
      const version = this.db.prepare("PRAGMA user_version").get() as Row;
      if (version.user_version !== 0 && version.user_version !== 1) {
        throw new Error("unsupported account database schema");
      }
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), chain INTEGER NOT NULL, rp TEXT NOT NULL, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_handle TEXT UNIQUE NOT NULL, state TEXT NOT NULL CHECK(state IN ('registering','queued','provisioning','verified')), legacy INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), role TEXT NOT NULL CHECK(role IN ('primary','secondary')), public_key BLOB NOT NULL, counter INTEGER NOT NULL, x TEXT NOT NULL, y TEXT NOT NULL, user_handle TEXT, metadata TEXT NOT NULL DEFAULT '{}', UNIQUE(account_id,role));
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, account_id TEXT REFERENCES accounts(id), authenticated INTEGER NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, purpose TEXT NOT NULL, role TEXT, challenge TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submission_owners (account_id TEXT NOT NULL REFERENCES accounts(id), id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY(account_id,id));
      CREATE TABLE IF NOT EXISTS consumed_approvals (account_id TEXT NOT NULL REFERENCES accounts(id), credential_id TEXT NOT NULL REFERENCES credentials(id), fingerprint TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(account_id,fingerprint));
      CREATE INDEX IF NOT EXISTS account_credentials ON credentials(account_id);
      PRAGMA user_version=1; COMMIT;`);
      const identity = this.db
        .prepare("SELECT * FROM identity WHERE id=1")
        .get() as Row | undefined;
      if (
        identity &&
        (identity.chain !== base.chainId ||
          identity.rp !== base.rpId ||
          identity.origin !== base.origin)
      ) {
        throw new Error("account database environment mismatch");
      }
      this.db
        .prepare("INSERT OR IGNORE INTO identity VALUES (1,?,?,?)")
        .run(base.chainId, base.rpId, base.origin);
      this.validateEvidenceInventory();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const v = operation();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  private decodeAccount(row: Row): AccountRecord {
    const id = String(row.id);
    identifier(id);
    const legacy = row.legacy === 1;
    if (legacy && id !== "legacy")
      throw new Error("invalid legacy account binding");
    const directory = assertExternalBackendPath(
      join(this.dataDirectory, id),
      "account directory",
    );
    if (
      directory !== join(this.dataDirectory, id) ||
      relative(this.dataDirectory, directory).startsWith("..")
    )
      throw new Error("account directory escapes its managed root");
    return Object.freeze({
      id,
      userHandle: String(row.user_handle),
      state: row.state as AccountRecord["state"],
      legacy,
      config: legacy
        ? this.base
        : {
            ...this.base,
            journalPath: join(directory, "submissions.json"),
            provisioningJournalPath: join(directory, "provisioning.json"),
            provisioningReviewDirectory: join(directory, "reviews"),
          },
    });
  }
  validateEvidenceInventory(): void {
    if (!existsSync(this.databasePath))
      throw new Error("account registry disappeared");
    const directory = opendirSync(this.dataDirectory);
    try {
      for (
        let entry = directory.readSync();
        entry;
        entry = directory.readSync()
      ) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          !/^[A-Za-z0-9-]{1,64}$/.test(entry.name)
        )
          throw new Error("account registry has unknown evidence entries");
        const row = this.db
          .prepare("SELECT id FROM accounts WHERE id=? AND legacy=0")
          .get(entry.name);
        if (!row)
          throw new Error("account registry omits retained execution evidence");
        this.account(entry.name);
      }
    } finally {
      directory.closeSync();
    }
  }
  createAccount(): AccountRecord {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO accounts VALUES (?,?, 'registering',0,?)")
      .run(id, randomBytes(32).toString("base64url"), this.now());
    return this.account(id)!;
  }
  account(id: string): AccountRecord | undefined {
    identifier(id);
    const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as
      Row | undefined;
    return row && this.decodeAccount(row);
  }
  *accounts(): IterableIterator<AccountRecord> {
    for (const row of this.db
      .prepare("SELECT * FROM accounts ORDER BY created,id")
      .iterate())
      yield this.decodeAccount(row as Row);
  }
  adoptLegacy(): AccountRecord {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO accounts VALUES ('legacy',?,'queued',1,?)",
      )
      .run(randomBytes(32).toString("base64url"), this.now());
    return this.account("legacy")!;
  }
  markProvisioning(id: string, state: AccountRecord["state"]): void {
    if (!this.account(id)) throw new Error("unknown account");
    this.db.prepare("UPDATE accounts SET state=? WHERE id=?").run(state, id);
  }
  private decodeCredential(row: Row): AccountCredential {
    const metadata = JSON.parse(String(row.metadata)) as Record<
      string,
      unknown
    >;
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Object.keys(metadata).some(
        (k) => !["backupEligible", "backedUp", "transports"].includes(k),
      ) ||
      [metadata.backupEligible, metadata.backedUp].some(
        (v) => v !== undefined && typeof v !== "boolean",
      ) ||
      (metadata.transports !== undefined &&
        (!Array.isArray(metadata.transports) ||
          metadata.transports.some((v) => typeof v !== "string")))
    )
      throw new Error("invalid credential metadata");
    return Object.freeze({
      accountId: String(row.account_id),
      id: String(row.id),
      role: row.role as BackendPasskeyRole,
      publicKey: Uint8Array.from(row.public_key as Uint8Array),
      counter: Number(row.counter),
      x: BigInt(String(row.x)),
      y: BigInt(String(row.y)),
      ...(row.user_handle ? { userHandle: String(row.user_handle) } : {}),
      ...(metadata as Pick<
        StoredCredential,
        "backupEligible" | "backedUp" | "transports"
      >),
    });
  }
  credential(id: string): AccountCredential | undefined {
    const row = this.db
      .prepare("SELECT * FROM credentials WHERE id=?")
      .get(id) as Row | undefined;
    return row && this.decodeCredential(row);
  }
  credentials(id: string): readonly AccountCredential[] {
    if (!this.account(id)) throw new Error("unknown account");
    return this.db
      .prepare("SELECT * FROM credentials WHERE account_id=? ORDER BY role")
      .all(id)
      .map((row) => this.decodeCredential(row as Row));
  }
  storeCredential(
    id: string,
    value: StoredCredential,
    userHandle?: string,
  ): void {
    if (
      !this.account(id) ||
      !value.id ||
      !Number.isSafeInteger(value.counter) ||
      value.counter < 0
    )
      throw new Error("invalid account credential");
    this.transaction(() => {
      if (
        this.credentials(id).some(
          (c) =>
            c.role === value.role ||
            (c.x === value.x && c.y === value.y) ||
            Buffer.from(c.publicKey).equals(Buffer.from(value.publicKey)),
        )
      )
        throw new Error(
          "account roles are immutable and must use distinct keys",
        );
      this.db.prepare("INSERT INTO credentials VALUES (?,?,?,?,?,?,?,?,?)").run(
        value.id,
        id,
        value.role,
        value.publicKey,
        value.counter,
        value.x.toString(),
        value.y.toString(),
        userHandle ?? null,
        JSON.stringify({
          ...(value.backupEligible === undefined
            ? {}
            : {
                backupEligible: value.backupEligible,
                backedUp: value.backedUp,
              }),
          ...(value.transports ? { transports: value.transports } : {}),
        }),
      );
    });
  }
  updateCounter(id: string, previous: number, next: number): void {
    if (!Number.isSafeInteger(next) || next < previous || next < 0)
      throw new Error("invalid credential counter");
    const changed = this.db
      .prepare("UPDATE credentials SET counter=? WHERE id=? AND counter=?")
      .run(next, id, previous);
    if (changed.changes !== 1)
      throw new Error("credential counter changed; use a fresh assertion");
  }
  consumeApproval(
    accountId: string,
    credentialId: string,
    previous: number,
    next: number,
    fingerprint: string,
  ): void {
    this.transaction(() => {
      const c = this.credential(credentialId);
      if (!c || c.accountId !== accountId)
        throw new Error("approval credential account mismatch");
      this.updateCounter(credentialId, previous, next);
      this.db
        .prepare("INSERT INTO consumed_approvals VALUES (?,?,?,?)")
        .run(accountId, credentialId, fingerprint, this.now());
    });
  }
  learnApproval(
    accountId: string,
    credential: StoredCredential,
    next: number,
    fingerprint: string,
  ): void {
    this.transaction(() => {
      this.storeCredential(accountId, { ...credential, counter: 0 });
      this.consumeApproval(accountId, credential.id, 0, next, fingerprint);
    });
  }
  createSession(accountId?: string, authenticated = false): NewAccountSession {
    if (authenticated && !accountId)
      throw new Error("authenticated session requires an account");
    if (accountId && !this.account(accountId))
      throw new Error("unknown account");
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url"),
      now = this.now();
    this.db
      .prepare("DELETE FROM sessions WHERE expires<=? OR last_used<=?")
      .run(now, now - 30 * 60_000);
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)")
      .run(
        id,
        hash(token),
        accountId ?? null,
        authenticated ? 1 : 0,
        now,
        now,
        now + 12 * 60 * 60_000,
      );
    return Object.freeze({
      id,
      token,
      ...(accountId ? { accountId } : {}),
      authenticated,
      csrfToken: csrf(token),
    });
  }
  session(token: string): AccountSession | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash=?")
      .get(hash(token)) as Row | undefined;
    if (!row) return;
    const now = this.now();
    if (
      Number(row.expires) <= now ||
      Number(row.last_used) + 30 * 60_000 <= now
    ) {
      this.revokeSession(token);
      return;
    }
    this.db
      .prepare("UPDATE sessions SET last_used=? WHERE id=?")
      .run(now, row.id);
    return Object.freeze({
      id: String(row.id),
      ...(row.account_id ? { accountId: String(row.account_id) } : {}),
      authenticated: row.authenticated === 1,
      csrfToken: csrf(token),
    });
  }
  revokeSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
  }
  assertCsrf(session: AccountSession, value: unknown): void {
    if (
      typeof value !== "string" ||
      !/^[0-9a-f]{64}$/.test(value) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(session.csrfToken))
    )
      throw new Error("invalid session CSRF token");
  }
  createChallenge(
    sessionId: string,
    purpose: string,
    role?: BackendPasskeyRole,
  ): AccountChallenge {
    const id = randomUUID(),
      now = this.now(),
      challenge = Buffer.concat([
        Buffer.from(`vault-${purpose}:`),
        randomBytes(32),
      ]).toString("base64url");
    this.db.prepare("DELETE FROM challenges WHERE expires<=?").run(now);
    this.db
      .prepare("INSERT INTO challenges VALUES (?,?,?,?,?,?)")
      .run(id, sessionId, purpose, role ?? null, challenge, now + 5 * 60_000);
    return Object.freeze({ id, challenge, ...(role ? { role } : {}) });
  }
  consumeChallenge(
    sessionId: string,
    id: string,
    purpose: string,
    role?: BackendPasskeyRole,
  ): AccountChallenge {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM challenges WHERE id=? AND session_id=? AND purpose=? AND role IS ?",
        )
        .get(id, sessionId, purpose, role ?? null) as Row | undefined;
      if (!row || Number(row.expires) <= this.now())
        throw new Error("unknown, expired or consumed challenge");
      this.db.prepare("DELETE FROM challenges WHERE id=?").run(id);
      return Object.freeze({
        id,
        challenge: String(row.challenge),
        ...(role ? { role } : {}),
      });
    });
  }
  assertActiveSession(id: string, accountId: string): void {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE id=? AND account_id=? AND authenticated=1",
      )
      .get(id, accountId) as Row | undefined;
    if (
      !row ||
      Number(row.expires) <= this.now() ||
      Number(row.last_used) + 30 * 60_000 <= this.now()
    )
      throw new Error("account session expired or revoked");
  }
  submissionOwner(accountId: string, id: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT session_id FROM submission_owners WHERE account_id=? AND id=?",
      )
      .get(accountId, id) as Row | undefined;
    return row ? String(row.session_id) : undefined;
  }
  claimSubmission(accountId: string, id: string, sessionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO submission_owners VALUES (?,?,?)")
      .run(accountId, id, sessionId);
    this.assertSubmissionOwner(accountId, id, sessionId);
  }
  assertSubmissionOwner(
    accountId: string,
    id: string,
    sessionId: string,
  ): void {
    const row = this.db
      .prepare(
        "SELECT session_id FROM submission_owners WHERE account_id=? AND id=?",
      )
      .get(accountId, id) as Row | undefined;
    if (!row || row.session_id !== sessionId)
      throw new Error("submission belongs to another session");
  }
  close(): void {
    this.db.close();
  }
}
