import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { createAutomatedCredential } from "../../../scripts/live/webauthn";
import { loadCredential, loadFundingKey, saveCredential } from "../../../scripts/live/secrets";

describe("outside-repository live secrets", () => {
  let dir: string, repository: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vault-secret-test-")); repository = join(dir, "repo"); mkdirSync(repository); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it("loads a funding key only from a private external regular file", () => {
    const path = join(dir, "funding-key");
    const key = generatePrivateKey();
    writeFileSync(path, key, { mode: 0o600 });
    expect(loadFundingKey(path, repository)).to.equal(key);
    chmodSync(path, 0o644);
    expect(() => loadFundingKey(path, repository)).to.throw("secret file rejected");
    chmodSync(path, 0o600);
    symlinkSync(path, join(dir, "link"));
    expect(() => loadFundingKey(join(dir, "link"), repository)).to.throw("secret file rejected");
    writeFileSync(join(repository, "key"), key, { mode: 0o600 });
    expect(() => loadFundingKey(join(repository, "key"), repository)).to.throw("secret file rejected");
  });
  it("persists a credential privately without overwriting an existing identity", () => {
    const path = join(dir, "credential.json");
    const credential = createAutomatedCredential();
    saveCredential(path, repository, credential);
    expect(statSync(path).mode & 0o777).to.equal(0o600);
    expect(loadCredential(path, repository)).to.deep.equal(credential);
    const before = readFileSync(path, "utf8");
    expect(() => saveCredential(path, repository, createAutomatedCredential())).to.throw("credential persistence failed");
    expect(readFileSync(path, "utf8")).to.equal(before);
  });
  it("rejects malformed keys and mismatched credentials without exposing their content", () => {
    const path = join(dir, "invalid");
    writeFileSync(path, "sensitive-invalid-content", { mode: 0o600 });
    expect(() => loadFundingKey(path, repository)).to.throw("funding key rejected");
    expect(() => loadCredential(path, repository)).to.throw("credential rejected");
    const credential = createAutomatedCredential();
    writeFileSync(path, JSON.stringify({ ...credential, x: "0", y: credential.y.toString() }));
    expect(() => loadCredential(path, repository)).to.throw("credential rejected");
  });
  it("rejects a FIFO without blocking the caller", () => {
    const path = join(dir, "fifo");
    expect(spawnSync("mkfifo", [path]).status).to.equal(0);
    chmodSync(path, 0o600);
    const child = spawnSync(process.execPath, [require.resolve("tsx/cli"), "-e", `import {loadFundingKey} from './scripts/live/secrets'; loadFundingKey(${JSON.stringify(path)}, ${JSON.stringify(repository)});`], { encoding: "utf8", timeout: 5000 });
    expect(child.error, "FIFO read must not time out").to.equal(undefined);
    expect(child.status).to.equal(1);
    expect(child.stderr).to.include("secret file rejected");
  });
  it("rejects private directories inside replaceable non-sticky ancestors", () => {
    const ancestor = join(dir, "shared");
    const privateDir = join(ancestor, "private");
    mkdirSync(ancestor); chmodSync(ancestor, 0o777); mkdirSync(privateDir, { mode: 0o700 });
    expect(() => saveCredential(join(privateDir, "credential.json"), repository, createAutomatedCredential())).to.throw("credential persistence failed");
  });
});
