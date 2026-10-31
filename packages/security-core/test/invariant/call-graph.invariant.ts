import { expect } from "chai";
import { readFileSync } from "node:fs";
import hre from "hardhat";

describe("call graph security invariant", () => {
  const source = readFileSync("contracts/TieredSpendingGuard.sol", "utf8");
  const graph = readFileSync("docs/security/call-graph.md", "utf8");
  const mutabilityPatterns: Record<string, RegExp> = {
    view: /view/i,
    pure: /pure/i,
    stateChanging: /state-changing/i,
  };

  it("keeps the static inventory honest about its limitation", () => {
    for (const surface of ["checkTransaction", "checkAfterExecution", "checkModuleTransaction", "checkAfterModuleExecution", "setAssetPolicy", "repairSigner", "repairPolicy", "freeze"]) {
      expect(source, surface).to.contain(`function ${surface}`);
      expect(graph, surface).to.contain(surface);
    }
    for (const threat of ["Direct owner transfers", "unlisted modules", "fallback handler", "approved-hash", "batches", "delegatecalls", "Approvals", "Monitoring and relaying"]) {
      expect(graph.toLowerCase(), threat).to.contain(threat.toLowerCase());
    }
  });

  it("checks the deployed public/state surface and Safe-only entry points", async () => {
    const documented = new Map([...graph.matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm)].map((match) => [match[1], match[2]]));
    for (const contractName of ["TieredSpendingGuard", "GuardReplacementMaintenance"]) {
      const artifact = await hre.artifacts.readArtifact(contractName);
      for (const item of artifact.abi.filter((entry): entry is { type: "function"; name: string; stateMutability: string } => entry.type === "function")) {
        const classification = documented.get(`${contractName}.${item.name}`);
        expect(classification, `${contractName}.${item.name} missing from call graph`).to.be.a("string");
        const pattern = item.stateMutability === "nonpayable" || item.stateMutability === "payable" ? mutabilityPatterns.stateChanging : mutabilityPatterns[item.stateMutability];
        expect(pattern, `${contractName}.${item.name} has unsupported mutability`).to.be.instanceOf(RegExp);
        expect(classification, `${contractName}.${item.name} missing mutability classification`).to.match(pattern);
      }
    }
    const guardFunctions = (await hre.artifacts.readArtifact("TieredSpendingGuard")).abi.filter((item) => item.type === "function").map((item) => item.type === "function" ? item.name : "");
    expect(guardFunctions).not.to.include.members(["withdraw", "transfer", "execute", "send"]);
    expect(source).to.match(/function checkTransaction[\s\S]*?external override onlySafe/);
    expect(source).to.match(/function checkModuleTransaction[\s\S]*?external override onlySafe/);
    expect(source).to.not.match(/function (withdraw|transfer|execute|send)\s*\(/);
    expect(source).to.contain("if (module != config.delay");
    expect(source).to.contain("if (frozen || operation != Enum.Operation.Call)");
  });

  it("has explicit fail-closed branches for signature, queue, call, and secondary-signer repair validation", () => {
    for (const marker of ["InvalidPasskeySignature", "MissingEcdsaSecondaryExtension", "InvalidEcdsaSecondarySignature", "InvalidDelayedAction", "UnsupportedTransfer", "role > 1", "_isExactPolicyRepair", "_authorizeQueueProposal"]) {
      expect(source, marker).to.contain(marker);
    }
    expect(graph).to.contain("primary plus exactly one configured secondary");
    expect(graph).to.not.match(/two-owner|two owner|passkey\/Burner|\[passkey, Burner\]/i);
  });

  it("keeps contract-only ECDSA authorization disabled without changing the dual profile", async () => {
    const [deployer, primary, ecdsaSecondary, delay] = await hre.viem.getWalletClients();
    const contractOnly = await hre.viem.deployContract("TieredSpendingGuard", [[deployer.account.address, primary.account.address, "0x0000000000000000000000000000000000000000", delay.account.address, 86400n, 0n]]);
    const dual = await hre.viem.deployContract("TieredSpendingGuard", [[deployer.account.address, primary.account.address, ecdsaSecondary.account.address, delay.account.address, 86400n, 0n]]);

    expect(await contractOnly.read.ecdsaSecondary()).to.deep.equal(["0x0000000000000000000000000000000000000000", 1, false]);
    const dualEcdsa = await dual.read.ecdsaSecondary();
    expect(dualEcdsa[0].toLowerCase()).to.equal(ecdsaSecondary.account.address.toLowerCase());
    expect(dualEcdsa.slice(1)).to.deep.equal([1, true]);
  });
});
