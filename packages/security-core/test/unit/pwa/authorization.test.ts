import { expect } from "chai";
import { readFileSync } from "node:fs";
import {
  loadCommittedPwaProvisioningAutomationPolicy,
  loadPwaProvisioningAutomationPolicy,
} from "../../../src/pwa/authorization";

describe("automatic PWA provisioning policy", () => {
  it("loads dynamic margins and budget without per-transaction gas or fee constants", () => {
    const policy = loadCommittedPwaProvisioningAutomationPolicy();

    expect(policy).to.deep.equal({
      formatVersion: 1,
      scope: "sepolia-pwa-provisioning-automation",
      chainId: 11155111,
      profileRevision: "sepolia-pwa-phase-one-v1",
      safeProxySaltNonce: 0n,
      gasMarginBps: 3000n,
      feeMarginBps: 3000n,
      maxEstimateDivergenceBps: 1000n,
      maxHeadLagBlocks: 2n,
      maxTotalOutlayWei: 50_000_000_000_000_000n,
    });
    expect("transactions" in policy).to.equal(false);
  });

  it("rejects unknown fields, fixed caps, and changed dynamic policy values", () => {
    const committed = JSON.parse(readFileSync("config/sepolia.pwa-provisioning-automation.json", "utf8"));
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, unknown: true })).to.throw(/unknown/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, transactions: [] })).to.throw(/unknown/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, chainId: 1 })).to.throw(/Sepolia/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, safeProxySaltNonce: "1" })).to.throw(/salt/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, gasMarginBps: "2999" })).to.throw(/gas margin/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, feeMarginBps: "3001" })).to.throw(/fee margin/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, maxEstimateDivergenceBps: "999" })).to.throw(/divergence/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, maxHeadLagBlocks: "3" })).to.throw(/head lag/i);
    expect(() => loadPwaProvisioningAutomationPolicy({ ...committed, maxTotalOutlayWei: "50000000000000001" })).to.throw(/outlay/i);
  });
});
