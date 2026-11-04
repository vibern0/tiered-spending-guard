import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import { queueFingerprint } from "../../src/queue/delay";
import { encodeSafeContractSignature } from "../../src/signers/passkey-helpers";
import { deploySafeFixture, ZERO, ecdsaSecondaryEnvelope, fn, passkeySignature, queueAbi, safeContractSignatures, signSafeTransaction, transferAbi } from "../helpers/safe";
const setNonceAbi = fn("setTxNonce", [{ name: "nonce", type: "uint256" }]);
const freezeAbi = fn("freeze", []);
const replaceSignerAbi = fn("replaceSigner", [{ name: "guard", type: "address" }, { name: "role", type: "uint8" }, { name: "expectedOld", type: "address" }, { name: "replacement", type: "address" }, { name: "previousOwner", type: "address" }, { name: "threshold", type: "uint256" }, { name: "replacementProof", type: "bytes" }]);
const replaceGuardsAbi = fn("replaceGuards", [{ name: "expectedGuard", type: "address" }, { name: "replacement", type: "address" }]);
const setCooldownAbi = fn("setTxCooldown", [{ name: "cooldown", type: "uint256" }]);
const setExpirationAbi = fn("setTxExpiration", [{ name: "expiration", type: "uint256" }]);
const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);
const repairPolicyAbi = fn("repairPolicy", [
  { name: "expectedPolicyHash", type: "bytes32" },
  { name: "token", type: "address" }, { name: "basePerTx", type: "uint256" }, { name: "stepUpPerTx", type: "uint256" },
  { name: "baseDaily", type: "uint256" }, { name: "instantDaily", type: "uint256" }, { name: "recipients", type: "address[]" },
  { name: "baseRecipientMode", type: "uint8" },
]);
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8" as Hex;
const MODULE_GUARD_SLOT = "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947" as Hex;
const itUnlessCoverage = process.env.SOLIDITY_COVERAGE === "true" ? it.skip : it;
const passkeyRepairProofHash = (chainId: bigint, safe: Address, delay: Address, guard: Address, expectedOld: Address, replacement: Address): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }],
    ["RecentTxSafeGuard.passkeyReplacement.v1", chainId, safe, delay, guard, expectedOld, replacement],
  ));

describe("pinned Zodiac Delay v1.1.1 integration", () => {
  async function fixture() {
    const [deployer, ecdsaSecondary, recipient, replacement, replacement2] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe, owners } = await deploySafeFixture(hre, deployer, [passkey.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]);
    await deployer.sendTransaction({ to: safe.address, value: 500n });
    const ownerTx = async (to: Address, data: Hex, signer = ecdsaSecondary) => {
      const signature = passkeySignature(passkey.address);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    await ownerTx(delay.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [safe.address] }));
    await ownerTx(safe.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [delay.address] }));
    await ownerTx(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerTx(guard.address, encodeFunctionData({ abi: fn("setMaintenance", [{ name: "replacementMaintenance", type: "address" }]), functionName: "setMaintenance", args: [maintenance.address] }));
    await ownerTx(safe.address, encodeFunctionData({ abi: fn("setModuleGuard", [{ name: "guard", type: "address" }]), functionName: "setModuleGuard", args: [guard.address] }));
    await ownerTx(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [{ name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" }, { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" }]), functionName: "setAssetPolicy", args: [ZERO, 50n, 100n, 50n, 100n, [recipient.account.address]] }));
    await ownerTx(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));
    const passkeySig = passkeySignature(passkey.address);
    const envelope = (signature: Hex) => ecdsaSecondaryEnvelope(passkey.address, signature);
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data);
    const passkeyAndSecondary = async (to: Address, data: Hex) => envelope(await sign(to, data, ecdsaSecondary));
    const execute = async (to: Address, data: Hex, signatures: Hex) => safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures], { account: deployer.account });
    const executeNext = (to: Address, value: bigint, data: Hex, operation: 0 | 1 = 0) => delay.write.executeNextTx([to, value, data, operation], { account: deployer.account });
    return { deployer, ecdsaSecondary, recipient, replacement, replacement2, safe, passkey, safeContractSecondary, delay, guard, maintenance, owners, ownerTx, sign, passkeySig, envelope, passkeyAndSecondary, execute, executeNext };
  }

  it("secondary signer Safe contract approval can queue an exact delayed action", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const { safe } = await deploySafeFixture(hre, deployer, [passkey.address, safeContractSecondary.address, ecdsaSecondary.account.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, passkey.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    await deployer.sendTransaction({ to: safe.address, value: 500n });
    const ownerCall = async (to: Address, data: Hex) => {
      const signature = await signSafeTransaction(safe, ecdsaSecondary, to, data);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    await ownerCall(delay.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [safe.address] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [delay.address] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [safeContractSecondary.address, true] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [ZERO, 50n, 100n, 50n, 100n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));

    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [recipient.account.address, 150n, "0x", 0] });
    await safe.write.execTransaction([delay.address, 0n, queued, 0, 0n, 0n, 0n, ZERO, ZERO, safeContractSignatures(passkey.address, safeContractSecondary.address)], { account: deployer.account });
    expect(await delay.read.queueNonce()).to.equal(1n);
    await time.increase(10);
    await delay.write.executeNextTx([recipient.account.address, 150n, "0x", 0], { account: deployer.account });
    expect(await delay.read.txNonce()).to.equal(1n);
  });

  it("rejects an ECDSA passkey owner on the delayed queue path", async () => {
    const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
    const { safe } = await deploySafeFixture(hre, deployer, [deployer.account.address, ecdsaSecondary.account.address]);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, deployer.account.address, ecdsaSecondary.account.address, delay.address, 86400n, 0n]]);
    const sign = async (to: Address, data: Hex, signer = ecdsaSecondary) => signSafeTransaction(safe, signer, to, data);
    const ownerCall = async (to: Address, data: Hex) => safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, await sign(to, data)], { account: deployer.account });
    await ownerCall(delay.address, encodeFunctionData({ abi: fn("enableModule", [{ name: "module", type: "address" }]), functionName: "enableModule", args: [safe.address] }));
    await ownerCall(guard.address, encodeFunctionData({ abi: fn("setAssetPolicy", [
      { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
      { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
    ]), functionName: "setAssetPolicy", args: [ZERO, 1n, 2n, 1n, 2n, [recipient.account.address]] }));
    await ownerCall(safe.address, encodeFunctionData({ abi: fn("setGuard", [{ name: "guard", type: "address" }]), functionName: "setGuard", args: [guard.address] }));
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [recipient.account.address, 2n, "0x", 0] });
    await expect(ownerCall(delay.address, queued)).to.be.rejected;
  });

  it("exercises real Delay cooldown, FIFO execution, cancellation, and requeue", async () => {
    const f = await fixture();
    expect(await (await hre.viem.getPublicClient()).getBalance({ address: f.safe.address })).to.equal(500n);
    expect((await f.delay.read.owner()).toLowerCase()).to.equal(f.safe.address.toLowerCase());
    expect((await f.delay.read.avatar()).toLowerCase()).to.equal(f.safe.address.toLowerCase());
    expect((await f.delay.read.target()).toLowerCase()).to.equal(f.safe.address.toLowerCase());
    expect(await f.delay.read.isModuleEnabled([f.safe.address])).to.equal(true);
    expect((await f.guard.read.assetPolicy([ZERO]))[3]).to.equal(100n);
    expect(await f.guard.read.allowedRecipient([ZERO, f.recipient.account.address])).to.equal(true);
    const queue = async (amount: bigint) => {
      const data = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.recipient.account.address, amount, "0x", 0] });
      const ecdsaSecondarySig = await f.sign(f.delay.address, data, f.ecdsaSecondary);
      await f.execute(f.delay.address, data, f.envelope(ecdsaSecondarySig));
      return data;
    };
    await queue(110n);
    const second = await queue(110n);
    expect(await f.delay.read.queueNonce()).to.equal(2n);
    await expect(f.executeNext(f.recipient.account.address, 110n, "0x")).to.be.rejected;
    await time.increase(10);
    await f.executeNext(f.recipient.account.address, 110n, "0x");
    await f.executeNext(f.recipient.account.address, 110n, "0x");
    expect(await (await hre.viem.getPublicClient()).getBalance({ address: f.recipient.account.address })).not.to.equal(0n);
    const third = await queue(110n);
    const cancel = encodeFunctionData({ abi: setNonceAbi, functionName: "setTxNonce", args: [3n] });
    await f.execute(f.delay.address, cancel, await f.passkeyAndSecondary(f.delay.address, cancel));
    expect(await f.delay.read.txNonce()).to.equal(3n);
    await queue(110n);
    await queue(110n);
    await time.increase(70);
    await f.delay.write.skipExpired({ account: f.deployer.account });
    await queue(110n);
    await time.increase(10);
    await f.executeNext(f.recipient.account.address, 110n, "0x");
    void second;
    void third;
  });

  it("requires primary plus a configured secondary for emergency freeze and cancellation", async () => {
    const f = await fixture();
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.recipient.account.address, 110n, "0x", 0] });
    await f.execute(f.delay.address, queued, await f.passkeyAndSecondary(f.delay.address, queued));
    expect(await f.delay.read.queueNonce()).to.equal(1n);
    const cancel = encodeFunctionData({ abi: setNonceAbi, functionName: "setTxNonce", args: [1n] });
    await f.execute(f.delay.address, cancel, safeContractSignatures(f.passkey.address, f.safeContractSecondary.address));
    expect(await f.delay.read.txNonce()).to.equal(1n);
    const freeze = encodeFunctionData({ abi: freezeAbi, functionName: "freeze" });
    await expect(f.execute(f.guard.address, freeze, f.passkeySig)).to.be.rejected;
    const ecdsaSecondarySig = await f.sign(f.guard.address, freeze, f.ecdsaSecondary);
    await f.execute(f.guard.address, freeze, f.envelope(ecdsaSecondarySig));
    expect(await f.guard.read.frozen()).to.equal(true);
    const item = { safe: f.safe.address, delay: f.delay.address, to: f.recipient.account.address, value: 0n, data: "0x" as Hex, operation: 0 as const, queueNonce: 0n };
    expect(queueFingerprint(item)).to.equal(await f.delay.read.getTransactionHash([item.to, item.value, item.data, item.operation]));
  });

  it("rotates a guard-only secondary after Delay without changing Safe ownership", async () => {
    const f = await fixture();
    const ecdsaSecondaryIndex = f.owners.findIndex((owner) => owner.toLowerCase() === f.ecdsaSecondary.account.address.toLowerCase());
    const previous = ZERO;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 1, f.ecdsaSecondary.account.address, f.replacement.account.address, previous, 1n, "0x"] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
    const signature = await f.passkeyAndSecondary(f.delay.address, queued);
    await f.execute(f.delay.address, queued, signature);
    await time.increase(10);
    await f.executeNext(f.maintenance.address, 0n, repair, 1);
    expect((await f.safe.read.getOwners()).map((x) => x.toLowerCase())).to.deep.equal([f.passkey.address.toLowerCase()]);
    expect((await f.safe.read.getOwners()).map((x) => x.toLowerCase())).not.to.include(f.ecdsaSecondary.account.address.toLowerCase());
    expect((await f.guard.read.maintenance()).toLowerCase()).to.equal(f.maintenance.address.toLowerCase());
    expect((await f.guard.read.config())[2].toLowerCase()).to.equal(f.replacement.account.address.toLowerCase());
  });

  it("keeps policy repair delayed, including deliberate weakening", async () => {
    const f = await fixture();
    const queueRepair = async (base: bigint, stepUp: bigint, daily: bigint, instant: bigint) => {
      const policyHash = await f.guard.read.policyHash();
      const repair = encodeFunctionData({ abi: repairPolicyAbi, functionName: "repairPolicy", args: [policyHash, ZERO, base, stepUp, daily, instant, [f.recipient.account.address], 0] });
      const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.guard.address, 0n, repair, 0] });
      const signature = await f.passkeyAndSecondary(f.delay.address, queued);
      await f.execute(f.delay.address, queued, signature);
      return repair;
    };

    const tightening = await queueRepair(40n, 90n, 40n, 90n);
    expect(await f.delay.read.queueNonce()).to.equal(1n);
    await expect(f.executeNext(f.guard.address, 0n, tightening)).to.be.rejected;
    await time.increase(10);
    await f.executeNext(f.guard.address, 0n, tightening);
    expect((await f.guard.read.assetPolicy([ZERO]))[0]).to.equal(40n);
    expect((await f.guard.read.assetPolicy([ZERO]))[3]).to.equal(90n);

    const weakening = await queueRepair(50n, 100n, 50n, 100n);
    expect(await f.delay.read.queueNonce()).to.equal(2n);
    await time.increase(10);
    await f.executeNext(f.guard.address, 0n, weakening);
    const weakened = await f.guard.read.assetPolicy([ZERO]);
    expect(weakened[0]).to.equal(50n);
    expect(weakened[1]).to.equal(100n);
    expect(weakened[2]).to.equal(50n);
    expect(weakened[3]).to.equal(100n);
  });

  it("fails a queued recipient addition as stale after the policy changes", async () => {
    const f = await fixture();
    const expectedPolicyHash = await f.guard.read.policyHash();
    const repair = encodeFunctionData({
      abi: repairPolicyAbi,
      functionName: "repairPolicy",
      args: [expectedPolicyHash, ZERO, 50n, 100n, 50n, 100n, [f.recipient.account.address, f.replacement.account.address], 0],
    });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.guard.address, 0n, repair, 0] });
    await f.execute(f.delay.address, queued, await f.passkeyAndSecondary(f.delay.address, queued));

    const immediateTightening = encodeFunctionData({
      abi: fn("setAssetPolicy", [
        { name: "token", type: "address" }, { name: "basePerTransaction", type: "uint256" }, { name: "stepUpPerTransaction", type: "uint256" },
        { name: "baseDailyLimit", type: "uint256" }, { name: "instantDailyLimit", type: "uint256" }, { name: "recipients", type: "address[]" },
      ]),
      functionName: "setAssetPolicy",
      args: [ZERO, 40n, 90n, 40n, 90n, [f.recipient.account.address]],
    });
    await f.execute(f.guard.address, immediateTightening, f.passkeySig);

    await time.increase(10);
    await expect(f.executeNext(f.guard.address, 0n, repair)).to.be.rejected;
    expect(await f.guard.read.allowedRecipient([ZERO, f.replacement.account.address])).to.equal(false);
  });

  it("rejects a contract that imitates the guard interfaces during replacement", async () => {
    const f = await fixture();
    const fake = await hre.viem.deployContract("FakeReplacementGuard", [f.safe.address, f.passkey.address, f.ecdsaSecondary.account.address, f.delay.address]);
    const repair = encodeFunctionData({ abi: replaceGuardsAbi, functionName: "replaceGuards", args: [f.guard.address, fake.address] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
    const signature = await f.passkeyAndSecondary(f.delay.address, queued);
    await f.execute(f.delay.address, queued, signature);
    await time.increase(10);
    await expect(f.executeNext(f.maintenance.address, 0n, repair, 1)).to.be.rejected;
  });

  // solidity-coverage instruments TieredSpendingGuard bytecode, so this
  // reviewed runtime-hash assertion is covered by the normal integration run.
  itUnlessCoverage("replaces both guard slots through delayed maintenance with an approved guard bound to the same signer set", async () => {
    const f = await fixture();
    const replacementGuard = await hre.viem.deployContract("TieredSpendingGuard", [[f.safe.address, f.passkey.address, f.ecdsaSecondary.account.address, f.delay.address, 86400n, 0n]]);
    const repair = encodeFunctionData({ abi: replaceGuardsAbi, functionName: "replaceGuards", args: [f.guard.address, replacementGuard.address] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
    const signature = await f.passkeyAndSecondary(f.delay.address, queued);
    await f.execute(f.delay.address, queued, signature);
    await time.increase(10);
    await f.executeNext(f.maintenance.address, 0n, repair, 1);

    const client = await hre.viem.getPublicClient();
    expect((await client.getStorageAt({ address: f.safe.address, slot: GUARD_SLOT }))!.toLowerCase().endsWith(replacementGuard.address.slice(2).toLowerCase())).to.equal(true);
    expect((await client.getStorageAt({ address: f.safe.address, slot: MODULE_GUARD_SLOT }))!.toLowerCase().endsWith(replacementGuard.address.slice(2).toLowerCase())).to.equal(true);
    expect((await replacementGuard.read.maintenance()).toLowerCase()).to.equal(f.maintenance.address.toLowerCase());
  });

  it("rejects delayed guard replacement when approved code is bound to a different ECDSA secondary", async () => {
    const f = await fixture();
    const replacementGuard = await hre.viem.deployContract("TieredSpendingGuard", [[f.safe.address, f.passkey.address, f.replacement2.account.address, f.delay.address, 86400n, 0n]]);
    const repair = encodeFunctionData({ abi: replaceGuardsAbi, functionName: "replaceGuards", args: [f.guard.address, replacementGuard.address] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
    const signature = await f.passkeyAndSecondary(f.delay.address, queued);
    await f.execute(f.delay.address, queued, signature);
    await time.increase(10);
    await expect(f.executeNext(f.maintenance.address, 0n, repair, 1)).to.be.rejected;

    const client = await hre.viem.getPublicClient();
    expect((await client.getStorageAt({ address: f.safe.address, slot: GUARD_SLOT }))!.toLowerCase().endsWith(f.guard.address.slice(2).toLowerCase())).to.equal(true);
    expect((await client.getStorageAt({ address: f.safe.address, slot: MODULE_GUARD_SLOT }))!.toLowerCase().endsWith(f.guard.address.slice(2).toLowerCase())).to.equal(true);
  });

  it("rejects an EOA replacement for the passkey role while retaining delayed signer rotation", async () => {
    const f = await fixture();
    const passkeyIndex = f.owners.indexOf(f.passkey.address);
    const previous = (passkeyIndex === 0 ? "0x0000000000000000000000000000000000000001" : f.owners[passkeyIndex - 1]) as Address;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 0, f.passkey.address, f.replacement.account.address, previous, 1n, "0x"] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
    const signature = await f.passkeyAndSecondary(f.delay.address, queued);
    await f.execute(f.delay.address, queued, signature);
    await time.increase(10);
    await expect(f.executeNext(f.maintenance.address, 0n, repair, 1)).to.be.rejected;
    expect((await f.guard.read.config())[1].toLowerCase()).to.equal(f.passkey.address.toLowerCase());
  });

  it("rotates a passkey signer only with exact ERC-1271 replacement proof", async () => {
    const f = await fixture();
    const replacementPasskey = await hre.viem.deployContract("HashBound1271Signer");
    const proof = "0x1234" as Hex;
    const proofHash = passkeyRepairProofHash(31337n, f.safe.address, f.delay.address, f.guard.address, f.passkey.address, replacementPasskey.address);
    await replacementPasskey.write.setAccepted([proofHash, proof], { account: f.deployer.account });
    const passkeyIndex = f.owners.findIndex((owner) => owner.toLowerCase() === f.passkey.address.toLowerCase());
    const previous = (passkeyIndex === 0 ? "0x0000000000000000000000000000000000000001" : f.owners[passkeyIndex - 1]) as Address;
    const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 0, f.passkey.address, replacementPasskey.address, previous, 1n, proof] });
    const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
    const signature = await f.passkeyAndSecondary(f.delay.address, queued);
    await f.execute(f.delay.address, queued, signature);
    await time.increase(10);
    await f.executeNext(f.maintenance.address, 0n, repair, 1);

    expect((await f.safe.read.getOwners()).map((x) => x.toLowerCase())).to.include(replacementPasskey.address.toLowerCase());
    expect((await f.safe.read.getOwners()).map((x) => x.toLowerCase())).not.to.include(f.passkey.address.toLowerCase());
    expect((await f.guard.read.config())[1].toLowerCase()).to.equal(replacementPasskey.address.toLowerCase());
    await expect(f.safe.write.execTransaction([f.recipient.account.address, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, f.passkeySig])).to.be.rejected;
    const nextHash = await f.safe.read.getTransactionHash([f.recipient.account.address, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, await f.safe.read.nonce()]);
    await replacementPasskey.write.setAccepted([nextHash, proof]);
    await f.safe.write.execTransaction([f.recipient.account.address, 1n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, encodeSafeContractSignature(replacementPasskey.address, proof)]);
  });

  for (const mutation of ["proof", "domain", "old signer", "predecessor"] as const) {
    it(`rolls back delayed primary rotation with wrong ${mutation}`, async () => {
      const f = await fixture();
      const candidate = await hre.viem.deployContract("HashBound1271Signer");
      const proof = "0x1234" as Hex;
      await candidate.write.setAccepted([passkeyRepairProofHash(mutation === "domain" ? 1n : 31337n, f.safe.address, f.delay.address, f.guard.address, f.passkey.address, candidate.address), proof]);
      const repair = encodeFunctionData({ abi: replaceSignerAbi, functionName: "replaceSigner", args: [f.guard.address, 0, mutation === "old signer" ? f.replacement.account.address : f.passkey.address, candidate.address, mutation === "predecessor" ? f.replacement.account.address : "0x0000000000000000000000000000000000000001", 1n, mutation === "proof" ? "0xabcd" : proof] });
      const queued = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.maintenance.address, 0n, repair, 1] });
      await f.execute(f.delay.address, queued, await f.passkeyAndSecondary(f.delay.address, queued));
      const owners = await f.safe.read.getOwners();
      const config = await f.guard.read.config();
      const nonce = await f.delay.read.txNonce();
      await time.increase(10);
      await expect(f.executeNext(f.maintenance.address, 0n, repair, 1)).to.be.rejected;
      expect(await f.safe.read.getOwners()).to.deep.equal(owners);
      expect(await f.guard.read.config()).to.deep.equal(config);
      expect(await f.delay.read.txNonce()).to.equal(nonce);
    });
  }

  it("permits only monotonic Delay tightening on the immediate owner path", async () => {
    const f = await fixture();
    const increaseCooldown = encodeFunctionData({ abi: setCooldownAbi, functionName: "setTxCooldown", args: [20n] });
    await f.execute(f.delay.address, increaseCooldown, f.passkeySig);
    await expect(f.execute(f.delay.address, encodeFunctionData({ abi: setCooldownAbi, functionName: "setTxCooldown", args: [5n] }), f.passkeySig)).to.be.rejected;
    await f.execute(f.delay.address, encodeFunctionData({ abi: setExpirationAbi, functionName: "setTxExpiration", args: [60n] }), f.passkeySig);
    await expect(f.execute(f.delay.address, encodeFunctionData({ abi: setExpirationAbi, functionName: "setTxExpiration", args: [70n] }), f.passkeySig)).to.be.rejected;
  });

  it("rejects malformed, trailing, mutated, delegatecall, and batch queue payloads", async () => {
    const f = await fixture();
    const valid = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.recipient.account.address, 110n, "0x", 0] });
    const signedQueue = async (data: Hex) => {
      const signature = await f.sign(f.delay.address, data, f.ecdsaSecondary);
      return f.envelope(signature);
    };
    await expect(f.execute(f.delay.address, valid.slice(0, -2) as Hex, await signedQueue(valid.slice(0, -2) as Hex))).to.be.rejected;
    const trailing = `${valid}00` as Hex;
    await expect(f.execute(f.delay.address, trailing, await signedQueue(trailing))).to.be.rejected;
    await f.execute(f.delay.address, valid, await signedQueue(valid));
    await time.increase(10);
    await expect(f.executeNext(f.recipient.account.address, 111n, "0x")).to.be.rejected;
    await f.executeNext(f.recipient.account.address, 110n, "0x");
    const delegate = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.recipient.account.address, 0n, "0x", 1] });
    await expect(f.execute(f.delay.address, delegate, await signedQueue(delegate))).to.be.rejected;
    const batch = encodeFunctionData({ abi: fn("multiSend", [{ name: "transactions", type: "bytes" }]), functionName: "multiSend", args: ["0x"] });
    const batchQueue = encodeFunctionData({ abi: queueAbi, functionName: "execTransactionFromModule", args: [f.recipient.account.address, 0n, batch, 0] });
    await expect(f.execute(f.delay.address, batchQueue, await signedQueue(batchQueue))).to.be.rejected;
  });
});
