import { expect } from "chai";
import hre from "hardhat";
import { encodeAbiParameters, encodeFunctionData, getContract, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { encodeSafeContractSignature } from "../../src/signers/passkey-helpers";
import { ECDSA_SECONDARY_SIGNATURE_TYPE_HASH } from "../../src/signers/eip1193";
import { ZERO, safeContractSignatures, signSafeTransaction } from "../helpers/safe";
import { createAutomatedCredential, signWebAuthn } from "../../scripts/live/webauthn";
import factoryArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json";
import verifierArtifact from "@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json";

export async function deployRealPasskey() {
  const [wallet] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const deploy = async (artifact: any) => {
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
    return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const verifier = await deploy(verifierArtifact);
  const factoryAddress = await deploy(factoryArtifact);
  const factory = getContract({ address: factoryAddress, abi: parseAbi([
    "function createSigner(uint256,uint256,uint176) returns (address)",
    "function getSigner(uint256,uint256,uint176) view returns (address)",
  ]), client: { public: publicClient, wallet } });
  const credential = createAutomatedCredential();
  const args = [credential.x, credential.y, BigInt(verifier)] as const;
  await factory.write.createSigner(args);
  const address = await factory.read.getSigner(args);
  const signer = getContract({ address, abi: parseAbi(["function isValidSignature(bytes32,bytes) view returns (bytes4)"]), client: publicClient });
  return { credential, signer, factory, verifier, address: address as Address };
}

describe("real Safe WebAuthn verification (automated credentials)", () => {
  it("verifies P-256 assertions and rejects another key, changed digest, and malformed assertion", async () => {
    const { credential, signer } = await deployRealPasskey();
    const digest = keccak256("0x1234");
    const assertion = signWebAuthn(credential, digest);
    expect(await signer.read.isValidSignature([digest, assertion])).to.equal("0x1626ba7e");
    expect(await signer.read.isValidSignature([keccak256("0x1235"), assertion])).not.to.equal("0x1626ba7e");
    expect(await signer.read.isValidSignature([digest, signWebAuthn(createAutomatedCredential(), digest)])).not.to.equal("0x1626ba7e");
    const malformed = await signer.read.isValidSignature([digest, "0x"]).catch(() => "reverted");
    expect(malformed).not.to.equal("0x1626ba7e");
  });

  it("enforces sole-owner X/Y, both secondary kinds, exact binding, rollback and Delay with real assertions", async () => {
    const [payer, secondaryEoa, recipient, stranger] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const primary = await deployRealPasskey();
    const secondary = await deployRealPasskey();
    const singleton = await hre.viem.deployContract("Safe");
    const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
    const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 120n, 600n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[safe.address, primary.address, secondaryEoa.account.address, delay.address, 86400n, 0n]]);
    const maintenance = await hre.viem.deployContract("GuardReplacementMaintenance", [safe.address, delay.address, ZERO]);
    const helper = await hre.viem.deployContract("SafeAtomicSetupHelper");
    const token = await hre.viem.deployContract("ERC20Mock", [safe.address, 1000n]);
    const setup = encodeFunctionData({ abi: helper.abi, functionName: "setup", args: [{
      guard: guard.address, delay: delay.address, maintenance: maintenance.address,
      passkey: primary.address, safeContractSecondary: secondary.address, ecdsaSecondary: secondaryEoa.account.address,
      periodSeconds: 86400n, periodAnchor: 0n,
      assets: [ZERO, token.address].map(token => ({ token, basePerTransaction: 10n, stepUpPerTransaction: 30n, baseDailyLimit: 10n, instantDailyLimit: 30n, baseRecipientMode: 0, recipients: [recipient.account.address] })),
    }] });
    await safe.write.setup([[primary.address], 1n, helper.address, setup, ZERO, ZERO, 0n, ZERO]);
    expect((await safe.read.getOwners()).map(x => x.toLowerCase())).to.deep.equal([primary.address.toLowerCase()]);
    await payer.sendTransaction({ to: safe.address, value: 1000n });
    type Kind = "base" | "contract" | "ecdsa";
    const digest = (to: Address, value: bigint, data: Hex, nonce: bigint) => safe.read.getTransactionHash([to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce]);
    const signatures = async (to: Address, value: bigint, data: Hex, kind: Kind) => {
      const hash = await digest(to, value, data, await safe.read.nonce());
      const raw = signWebAuthn(primary.credential, hash);
      if (kind === "contract") return safeContractSignatures(primary.address, secondary.address, raw, signWebAuthn(secondary.credential, hash));
      const first = encodeSafeContractSignature(primary.address, raw);
      if (kind === "base") return first;
      const second = await signSafeTransaction(safe, secondaryEoa, to, data, { value });
      return `${first}${second.slice(2)}${toHex(65n, { size: 32 }).slice(2)}${ECDSA_SECONDARY_SIGNATURE_TYPE_HASH.slice(2)}` as Hex;
    };
    const exec = (to: Address, value: bigint, data: Hex, sig: Hex) => safe.write.execTransaction([to, value, data, 0, 0n, 0n, 0n, ZERO, ZERO, sig]);
    const act = async (to: Address, value: bigint, data: Hex, kind: Kind = "base") => exec(to, value, data, await signatures(to, value, data, kind));
    const transfer = (amount: bigint) => encodeFunctionData({ abi: token.abi, functionName: "transfer", args: [recipient.account.address, amount] });
    for (const asset of [ZERO, token.address]) {
      const to = asset === ZERO ? recipient.account.address : token.address;
      const value = (n: bigint) => asset === ZERO ? n : 0n;
      const data = (n: bigint) => asset === ZERO ? "0x" as Hex : transfer(n);
      await act(to, value(6n), data(6n));
      await act(to, value(4n), data(4n));
      await expect(act(to, value(1n), data(1n))).to.be.rejected;
      await act(to, value(10n), data(10n), "contract");
      await act(to, value(10n), data(10n), "ecdsa");
      await expect(act(to, value(1n), data(1n), "ecdsa")).to.be.rejected;
      expect((await guard.read.spendState([asset])).slice(1)).to.deep.equal([10n, 30n]);
    }
    const before = await safe.read.nonce();
    const stale = await signatures(recipient.account.address, 1n, "0x", "contract");
    await expect(exec(stranger.account.address, 1n, "0x", stale)).to.be.rejected;
    await expect(exec(recipient.account.address, 1n, "0x", await secondaryEoa.signMessage({ message: "not a Safe transaction" }))).to.be.rejected;
    expect(await safe.read.nonce()).to.equal(before);
    expect((await guard.read.spendState([ZERO])).slice(1)).to.deep.equal([10n, 30n]);

    const queueData = encodeFunctionData({ abi: delay.abi, functionName: "execTransactionFromModule", args: [recipient.account.address, 31n, "0x", 0] });
    await expect(act(delay.address, 0n, queueData)).to.be.rejected;
    await act(delay.address, 0n, queueData, "contract");
    await expect(delay.write.executeNextTx([recipient.account.address, 31n, "0x", 0])).to.be.rejected;
    await act(delay.address, 0n, encodeFunctionData({ abi: delay.abi, functionName: "setTxNonce", args: [1n] }), "ecdsa");
    await time.increase(121);
    await expect(delay.write.executeNextTx([recipient.account.address, 31n, "0x", 0])).to.be.rejected;
    await act(delay.address, 0n, queueData, "ecdsa");
    await time.increase(721);
    await expect(delay.write.executeNextTx([recipient.account.address, 31n, "0x", 0])).to.be.rejected;
    await delay.write.skipExpired();
    await act(delay.address, 0n, queueData, "contract");
    const balance = await client.getBalance({ address: recipient.account.address });
    await time.increase(121);
    await delay.write.executeNextTx([recipient.account.address, 31n, "0x", 0]);
    expect(await client.getBalance({ address: recipient.account.address })).to.equal(balance + 31n);

    await time.increase(86401);
    const currentHash = await digest(recipient.account.address, 2n, "0x", await safe.read.nonce());
    const otherHash = await digest(recipient.account.address, 3n, "0x", await safe.read.nonce());
    const validPrimary = signWebAuthn(primary.credential, currentHash);
    await expect(exec(recipient.account.address, 2n, "0x", safeContractSignatures(primary.address, secondary.address, validPrimary, signWebAuthn(secondary.credential, otherHash)))).to.be.rejected;
    await exec(recipient.account.address, 2n, "0x", safeContractSignatures(primary.address, secondary.address, validPrimary, signWebAuthn(secondary.credential, currentHash)));

    const rollbackState = await guard.read.spendState([ZERO]);
    const rollbackNonce = await safe.read.nonce();
    const rollbackHash = await digest(recipient.account.address, 11n, "0x", rollbackNonce);
    const rollbackSignature = await signatures(recipient.account.address, 11n, "0x", "ecdsa");
    const ecdsaPayload = `0x${rollbackSignature.slice(-(65 + 32 + 32) * 2, -(32 + 32) * 2)}` as Hex;
    const authorization = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [rollbackHash, keccak256(ecdsaPayload)]));
    const vaultBalance = await client.getBalance({ address: safe.address });
    await hre.network.provider.send("hardhat_setBalance", [safe.address, "0x0"]);
    await expect(exec(recipient.account.address, 11n, "0x", rollbackSignature)).to.be.rejected;
    expect(await guard.read.spendState([ZERO])).to.deep.equal(rollbackState);
    expect(await safe.read.nonce()).to.equal(rollbackNonce);
    expect(await guard.read.ecdsaSecondaryAuthorizationUsed([authorization])).to.equal(false);
    await hre.network.provider.send("hardhat_setBalance", [safe.address, toHex(vaultBalance)]);
    await exec(recipient.account.address, 11n, "0x", rollbackSignature);
    expect(await guard.read.ecdsaSecondaryAuthorizationUsed([authorization])).to.equal(true);

    const one = await signatures(recipient.account.address, 1n, "0x", "base");
    await exec(recipient.account.address, 1n, "0x", one);
    await expect(exec(recipient.account.address, 1n, "0x", one)).to.be.rejected;
    await act(guard.address, 0n, encodeFunctionData({ abi: guard.abi, functionName: "freeze" }), "contract");
    await expect(act(recipient.account.address, 1n, "0x")).to.be.rejected;
  });
});
