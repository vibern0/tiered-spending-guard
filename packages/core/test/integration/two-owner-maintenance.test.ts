import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { deploySafeFixture, ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, queueAbi, signSafeTransaction } from "../helpers/safe";

const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);
const itUnlessCoverage = process.env.SOLIDITY_COVERAGE === "true" ? it.skip : it;
const freezeAbi = fn("freeze", []);
const repairSignerAbi = fn("repairSigner", [
  { name: "role", type: "uint8" },
  { name: "expectedOld", type: "address" },
  { name: "replacement", type: "address" },
]);
const setNonceAbi = fn("setTxNonce", [{ name: "nonce", type: "uint256" }]);
const repairPolicyAbi = fn("repairPolicy", [
  { name: "expectedPolicyHash", type: "bytes32" },
  { name: "token", type: "address" },
  { name: "basePerTx", type: "uint256" },
  { name: "stepUpPerTx", type: "uint256" },
  { name: "baseDaily", type: "uint256" },
  { name: "instantDaily", type: "uint256" },
  { name: "recipients", type: "address[]" },
  { name: "baseRecipientMode", type: "uint8" },
]);
const replaceSignerAbi = fn("replaceSigner", [
  { name: "guard", type: "address" },
  { name: "role", type: "uint8" },
  { name: "expectedOld", type: "address" },
  { name: "replacement", type: "address" },
  { name: "previousOwner", type: "address" },
  { name: "threshold", type: "uint256" },
  { name: "replacementProof", type: "bytes" },
]);
const replaceGuardsAbi = fn("replaceGuards", [
  { name: "expectedGuard", type: "address" },
  { name: "replacement", type: "address" },
]);
const passkeyRepairProofHash = (chainId: bigint, safe: Address, delay: Address, guard: Address, expectedOld: Address, replacement: Address): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
    ["RecentTxSafeGuard.passkeyReplacement.v1", chainId, safe, delay, guard, expectedOld, replacement],
  ));

describe("Single-owner guard maintenance", () => {
  async function fixture() {
    const [deployer, ecdsaSecondary, arbitrary, recipient, replacement] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const replacementSafeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe, owners } = await deploySafeFixture(hre, deployer, [passkey.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]);
    const passkeySig = passkeySignature(passkey.address);
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data);
    const envelope = (signature: Hex) => ecdsaSecondaryEnvelope(passkey.address, signature);
    const execute = (to: Address, data: Hex, signatures: Hex) => safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures], { account: deployer.account });
    const passkeyAndSecondary = async (to: Address, data: Hex) => execute(to, data, envelope(await sign(to, data, ecdsaSecondary)));
    const bootstrap = async (to: Address, data: Hex) => execute(to, data, passkeySig);
    await bootstrap(delay.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [safe.address] }));
    await bootstrap(safe.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [delay.address] }));
    await bootstrap(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await bootstrap(guard.address, encodeFunctionData({ abi: fn("setMaintenance", [{ name: "replacementMaintenance", type: "address" }]), functionName: "setMaintenance", args: [maintenance.address] }));
    await bootstrap(safe.address, encodeFunctionData({ abi: fn("setModuleGuard", [{ name: "guard", type: "address" }]), functionName: "setModuleGuard", args: [guard.address] }));
    await bootstrap(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));
    const executeNext = (to: Address, value: bigint, data: Hex, operation: 0 | 1 = 0) => delay.write.executeNextTx([to, value, data, operation], { account: deployer.account });
    return { deployer, ecdsaSecondary, arbitrary, recipient, replacement, replacementSafeContractSecondary, safe, passkey, safeContractSecondary, delay, guard, maintenance, owners, passkeySig, sign, envelope, execute, executeNext, passkeyAndSecondary };
  }

  it("sets up the Safe with only the primary owner at threshold one", async () => {
    const f = await fixture();
    expect(await f.safe.read.getThreshold()).to.equal(1n);
    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal(f.owners.map((owner) => owner.toLowerCase()));
    expect(f.owners.map((owner) => owner.toLowerCase())).to.deep.equal([f.passkey.address.toLowerCase()]);
  });

  it("rejects direct queued signer repair even when primary plus ECDSA secondary approve the queue", async () => {
    const f = await fixture();
    const directRepair = encodeFunctionData({ abi: repairSignerAbi, functionName: "repairSigner", args: [1, f.ecdsaSecondary.account.address, f.replacement.account.address] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.guard.address, 0n, directRepair, 0] });
    await expect(f.passkeyAndSecondary(f.delay.address, queued)).to.be.rejected;
  });

  it("rejects role 2 signer repair even when primary plus ECDSA secondary approve the queue", async () => {
    const f = await fixture();
    const repairRoleTwo = encodeFunctionData({ abi: repairSignerAbi, functionName: "repairSigner", args: [2, f.arbitrary.account.address, f.replacement.account.address] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.guard.address, 0n, repairRoleTwo, 0] });
    await expect(f.passkeyAndSecondary(f.delay.address, queued)).to.be.rejected;
  });

  it("requires primary plus ECDSA secondary for the secondary maintenance path", async () => {
    const f = await fixture();
    const freeze = encodeFunctionData({ abi: freezeAbi, functionName: "freeze" });
    await expect(f.execute(f.guard.address, freeze, f.passkeySig)).to.be.rejected;
    await f.passkeyAndSecondary(f.guard.address, freeze);
    expect(await f.guard.read.frozen()).to.equal(true);

    const policyHash = await f.guard.read.policyHash();
    const queuedRepair = encodeFunctionData({ abi: repairPolicyAbi, functionName: "repairPolicy", args: [policyHash, ZERO, 1n, 2n, 1n, 2n, [f.recipient.account.address], 0] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.guard.address, 0n, queuedRepair, 0] });
    await f.passkeyAndSecondary(f.delay.address, queued);
    expect(await f.delay.read.queueNonce()).to.equal(1n);

    const cancel = encodeFunctionData({ abi: setNonceAbi, functionName: "setTxNonce", args: [1n] });
    await expect(f.execute(f.delay.address, cancel, f.passkeySig)).to.be.rejected;
    await f.passkeyAndSecondary(f.delay.address, cancel);
    expect(await f.delay.read.txNonce()).to.equal(1n);

    const repair = encodeFunctionData({ abi: repairSignerAbi, functionName: "repairSigner", args: [1, f.ecdsaSecondary.account.address, f.replacement.account.address] });
    await expect(f.execute(f.guard.address, repair, f.passkeySig)).to.be.rejected;
  });

  it("permits immediate safe-contract secondary disabling but rejects immediate broadening", async () => {
    const f = await fixture();
    const disable = encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [f.safeContractSecondary.address, false] });
    await f.passkeyAndSecondary(f.guard.address, disable);
    expect((await f.guard.read.safeContractSecondary())[2]).to.equal(false);

    const broaden = encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [f.replacementSafeContractSecondary.address, true] });
    await expect(f.passkeyAndSecondary(f.guard.address, broaden)).to.be.rejected;
  });

  it("rotates the safe-contract secondary only through delayed maintenance", async () => {
    const f = await fixture();
    const secondaryIndex = f.owners.findIndex((owner) => owner.toLowerCase() === f.safeContractSecondary.address.toLowerCase());
    const previous = ZERO;
    const proofHash = passkeyRepairProofHash(31337n, f.safe.address, f.delay.address, f.guard.address, f.safeContractSecondary.address, f.replacementSafeContractSecondary.address);
    expect(proofHash).to.match(/^0x[0-9a-f]{64}$/);
    const proof = "0x" as Hex;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 1, f.safeContractSecondary.address, f.replacementSafeContractSecondary.address, previous, 1n, proof] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });

    await expect(f.execute(f.maintenance.address, repair, await f.sign(f.maintenance.address, repair))).to.be.rejected;
    await f.passkeyAndSecondary(f.delay.address, queued);
    await expect(f.executeNext(f.maintenance.address, 0n, repair, 1)).to.be.rejected;
    await time.increase(10);
    await f.executeNext(f.maintenance.address, 0n, repair, 1);

    expect((await f.guard.read.safeContractSecondary())[0].toLowerCase()).to.equal(f.replacementSafeContractSecondary.address.toLowerCase());
    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal([f.passkey.address.toLowerCase()]);
    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).not.to.include(f.safeContractSecondary.address.toLowerCase());
  });

  it("rotates and re-enables a disabled safe-contract secondary through delayed maintenance", async () => {
    const f = await fixture();
    const disable = encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [f.safeContractSecondary.address, false] });
    await f.passkeyAndSecondary(f.guard.address, disable);
    expect((await f.guard.read.safeContractSecondary())[2]).to.equal(false);

    const secondaryIndex = f.owners.findIndex((owner) => owner.toLowerCase() === f.safeContractSecondary.address.toLowerCase());
    const previous = ZERO;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 1, f.safeContractSecondary.address, f.replacementSafeContractSecondary.address, previous, 1n, "0x"] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });

    await f.passkeyAndSecondary(f.delay.address, queued);
    await time.increase(10);
    await f.executeNext(f.maintenance.address, 0n, repair, 1);

    const secondaryConfig = await f.guard.read.safeContractSecondary();
    expect(secondaryConfig[0].toLowerCase()).to.equal(f.replacementSafeContractSecondary.address.toLowerCase());
    expect(secondaryConfig[2]).to.equal(true);
    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal([f.passkey.address.toLowerCase()]);
    expect((await f.safe.read.getOwners()).map((owner) => owner.toLowerCase())).not.to.include(f.safeContractSecondary.address.toLowerCase());
  });

  itUnlessCoverage("replaces guards after immediate safe-contract secondary disable without re-broadening", async () => {
    const f = await fixture();
    const disable = encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [f.safeContractSecondary.address, false] });
    await f.passkeyAndSecondary(f.guard.address, disable);
    expect((await f.guard.read.safeContractSecondary())[2]).to.equal(false);

    const replacementGuard = await hre.viem.deployContract("TieredSpendingGuard", [[f.safe.address, f.passkey.address, f.ecdsaSecondary.account.address, f.delay.address, 86400n, 0n]]);
    const repair = encodeFunctionData({ abi: replaceGuardsAbi, functionName: "replaceGuards", args: [f.guard.address, replacementGuard.address] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });

    await f.passkeyAndSecondary(f.delay.address, queued);
    await time.increase(10);
    await f.executeNext(f.maintenance.address, 0n, repair, 1);

    expect((await replacementGuard.read.safeContractSecondary())[0].toLowerCase()).to.equal(f.safeContractSecondary.address.toLowerCase());
    expect((await replacementGuard.read.safeContractSecondary())[2]).to.equal(false);
    expect((await replacementGuard.read.maintenance()).toLowerCase()).to.equal(f.maintenance.address.toLowerCase());
  });

  it("does not allow ECDSA-secondary-only or arbitrary EOA-only transactions through the guard", async () => {
    const f = await fixture();
    const freeze = encodeFunctionData({ abi: freezeAbi, functionName: "freeze" });
    await expect(f.execute(f.guard.address, freeze, await f.sign(f.guard.address, freeze, f.ecdsaSecondary))).to.be.rejected;
    await expect(f.execute(f.recipient.account.address, "0x", await f.sign(f.recipient.account.address, "0x", f.arbitrary))).to.be.rejected;
  });
});
