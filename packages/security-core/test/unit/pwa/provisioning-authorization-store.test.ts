import { spawnSync } from "node:child_process";
import { expect } from "chai";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type Hex } from "viem";
import { createPwaProvisioningAuthorizationStore, pwaProvisioningAuthorizationHash, type PwaProvisioningTransactionAuthorization } from "../../../src/pwa";

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const record = (n: number): PwaProvisioningTransactionAuthorization => {
  const payload = Object.freeze({
  formatVersion: 1,
  scope: "sepolia-pwa-provisioning-transaction",
  packageHash: hash(1),
  planHash: hash(2),
  transactionId: n === 1 ? "primary-signer" : "secondary-signer",
  transactionHash: hash(10 + n),
  nonce: String(n),
  quoteBlockNumber: String(100 + n),
  quoteBlockHash: hash(100 + n),
  providers: ["provider-a", "provider-b"] as const,
  gasEstimateA: "100",
  gasEstimateB: "101",
  priorityFeeA: "2",
  priorityFeeB: "3",
  baseFeePerGas: "22",
  blockGasLimit: "100000000",
  gasMarginBps: "3000",
  feeMarginBps: "3000",
  gasLimit: "132",
  maxFeePerGas: "62",
  maxPriorityFeePerGas: "4",
  priorOutlayWei: String(n - 1),
  resultingOutlayWei: String(n),
  authorizedAt: `2026-11-01T18:00:0${n}.000Z`,
  }) satisfies Omit<PwaProvisioningTransactionAuthorization, "authorizationHash">;
  return Object.freeze({ ...payload, authorizationHash: pwaProvisioningAuthorizationHash(payload) });
};

describe("PWA provisioning authorization sidecar", () => {
  it("atomically appends records without overwriting prior evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-authorization-store-"));
    const path = join(directory, "authorizations.json");
    const store = createPwaProvisioningAuthorizationStore(path, { chainId: 11155111, deployer: address(1), packageHash: hash(1), planHash: hash(2) });
    try {
      store.append(record(1));
      store.append(record(2));
      expect(store.load().records).to.deep.equal([record(1), record(2)]);
      expect(JSON.parse(readFileSync(path, "utf8")).records).to.have.length(2);
      expect(() => store.append(record(2))).to.throw(/duplicate/i);
    } finally {
      store.close();
    }
  });

  it("rejects malformed or mismatched existing sidecars", () => {
    const directory = mkdtempSync(join(tmpdir(), "pwa-authorization-store-invalid-"));
    const path = join(directory, "authorizations.json");
    const identity = { chainId: 11155111, deployer: address(1), packageHash: hash(1), planHash: hash(2) } as const;
    const store = createPwaProvisioningAuthorizationStore(path, identity);
    store.close();
    const changed = JSON.parse(readFileSync(path, "utf8"));
    changed.deployer = address(9);
    writeFileSync(path, JSON.stringify(changed));
    expect(() => createPwaProvisioningAuthorizationStore(path, identity)).to.throw(/identity/i);
  });
});


describe("authorization sidecar restart locking", () => {
  it("reclaims only a proved-dead writer without modifying prior authorization records", () => {
    const directory=mkdtempSync(join(tmpdir(),"pwa-auth-restart-")),path=join(directory,"authorization.json");
    const identity={chainId:11155111,deployer:address(1),packageHash:hash(1),planHash:hash(2)} as const;
    const first=createPwaProvisioningAuthorizationStore(path,identity);first.append(record(1));first.close();
    const before=readFileSync(path,"utf8");
    const child=spawnSync(process.execPath,["-e","process.stdout.write(String(process.pid))"],{encoding:"utf8"});
    expect(child.status).to.equal(0);writeFileSync(`${path}.lock`,`${child.stdout}\n`);
    const restarted=createPwaProvisioningAuthorizationStore(path,identity);
    try {expect(readFileSync(path,"utf8")).to.equal(before);expect(restarted.load().records).to.deep.equal([record(1)]);}finally{restarted.close();}
  });
  it("preserves live and malformed lock ownership", () => {
    const directory=mkdtempSync(join(tmpdir(),"pwa-auth-lock-")),path=join(directory,"authorization.json");
    const identity={chainId:11155111,deployer:address(1),packageHash:hash(1),planHash:hash(2)} as const;
    for(const contents of [`${process.pid}\n`,"not-a-pid\n"]) {
      writeFileSync(`${path}.lock`,contents);
      expect(()=>createPwaProvisioningAuthorizationStore(path,identity)).to.throw(/lock unavailable/);
      expect(readFileSync(`${path}.lock`,"utf8")).to.equal(contents);
    }
  });
});
