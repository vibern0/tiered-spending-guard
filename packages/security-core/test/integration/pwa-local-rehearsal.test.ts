import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import {
  LOCAL_PWA_ACTION_IDS,
  createLocalPwaReview,
  runLocalPwaCli,
  writeLocalPwaReviewPackage,
} from "../../scripts/pwa/rehearse-local";
import { PWA_RECIPIENT, SEPOLIA_USDC_ADDRESS } from "../../src/pwa/profile";

const h = (value: number) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const a = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as `0x${string}`;

function review() {
  return createLocalPwaReview({
    formatVersion: 2,
    profileId: "local",
    chainId: 11155111,
    safe: a(1), guard: a(2), delay: a(3), usdc: SEPOLIA_USDC_ADDRESS, baseRecipientMode: "any-valid-address", elevatedRecipients: [PWA_RECIPIENT],
    primaryCredentialHash: h(4), secondaryCredentialHash: h(5), deploymentsHash: h(6), policyHash: h(7), topologyReportHash: h(8),
    observer: { processId: "pwa-local-observer", executableHash: h(9), sources: ["provider-a", "provider-b"], confirmations: 6 },
    deadline: "2026-11-01T12:00:00.000Z",
  });
}

describe("gated localhost PWA rehearsal", () => {
  it("emits one deterministic unsigned nine-step review with exact principal, caps, and terminal state", () => {
    const first = review();
    const second = review();
    expect(first).to.deep.equal(second);
    expect(first.authorization).to.equal("NONE");
    expect(first.actions.map((action) => action.id)).to.deep.equal(LOCAL_PWA_ACTION_IDS);
    expect(first.principal).to.equal("8000000");
    expect(first.expectedTerminal).to.deep.include({ safeUsdcBalance: "1000000", queueDepth: "0", baseSpent: "1000000", instantSpent: "3000000" });
    expect(first.actions.find((action) => action.id === "early-reject")!.broadcast).to.equal(false);
    expect(first.actions.filter((action) => action.broadcast).every((action) => BigInt(action.maxGas) > 0n)).to.equal(true);
  });

  it("writes a public review package without authority and refuses overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "pwa-local-review-"));
    const output = join(root, "review");
    try {
      const manifest = writeLocalPwaReviewPackage(review(), output);
      expect(manifest.reviewHash).to.equal(review().reviewHash);
      expect(JSON.parse(readFileSync(join(output, "review.json"), "utf8"))).to.deep.equal(review());
      expect(() => writeLocalPwaReviewPackage(review(), output)).to.throw(/exist|output/i);
      expect(readFileSync(join(output, "manifest.json"), "utf8")).not.to.match(/private|signature|assertion|rpc/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects the same credential binding for both authenticator roles", () => {
    const { scope: _scope, authorization: _authorization, principal: _principal, actions: _actions, maximumGas: _maximumGas, maximumEthOutlayWei: _maximumEthOutlayWei, expectedTerminal: _expectedTerminal, reviewHash: _reviewHash, ...input } = review();
    expect(() => createLocalPwaReview({ ...input, primaryCredentialHash: input.secondaryCredentialHash })).to.throw(/credential|differ/i);
  });

  it("fails closed instead of importing caller-selected submit or resume modules", async () => {
    await expect(runLocalPwaCli(["submit-one", "/tmp/review", "/tmp/approval", "/tmp/journal", "/tmp/adapter.ts"])).to.be.rejectedWith(/disabled|fixed in-repository/i);
    await expect(runLocalPwaCli(["resume-one", "/tmp/review", "/tmp/journal", "/tmp/adapter.ts"])).to.be.rejectedWith(/disabled|fixed in-repository/i);
  });
});
