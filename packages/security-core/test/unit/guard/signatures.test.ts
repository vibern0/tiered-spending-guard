import { expect } from "chai";
import hre from "hardhat";
import { encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { fn, signSafeTransaction } from "../../helpers/safe";
import { encodeGuardContractSignatures } from "../../../src/signers/guard-signatures";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const configureSafeContractSecondaryAbi = fn("configureSafeContractSecondary", [
  { name: "signer", type: "address" },
  { name: "enabled", type: "bool" },
]);

async function fixture() {
  const [deployer, ecdsaSecondary, recipient] = await hre.viem.getWalletClients();
  const singleton = await hre.viem.deployContract("Safe");
  const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
  const safe = await hre.viem.getContractAt("Safe", proxy.address);
  const passkey = await hre.viem.deployContract("Mock1271Signer");
  const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
  const guard = await hre.viem.deployContract("TieredSpendingGuard", [[
    safe.address,
    passkey.address,
    ecdsaSecondary.account.address,
    delay.address,
    86400n,
    0n,
  ]]);
  const owners = [passkey.address, ecdsaSecondary.account.address].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  await safe.write.setup([
    owners,
    1n,
    ZERO,
    "0x",
    ZERO,
    ZERO,
    0n,
    ZERO,
  ], { account: deployer.account });
  return { deployer, ecdsaSecondary, recipient, safe, passkey, guard };
}

describe("TieredSpendingGuard exact signatures", () => {
  it("encodes verified contract payloads in primary-first layout without an ECDSA path", () => {
    const primary = "0x1111111111111111111111111111111111111111" as Address;
    const secondary = "0x2222222222222222222222222222222222222222" as Address;
    const encoded = encodeGuardContractSignatures({ address: primary, payload: "0x1234" }, { address: secondary, payload: "0xaabbcc" });
    const bytes = Buffer.from(encoded.slice(2), "hex");
    expect(`0x${bytes.subarray(12, 32).toString("hex")}`).to.equal(primary);
    expect(BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`)).to.equal(130n);
    expect(bytes[64]).to.equal(0);
    expect(`0x${bytes.subarray(77, 97).toString("hex")}`).to.equal(secondary);
    expect(BigInt(`0x${bytes.subarray(97, 129).toString("hex")}`)).to.equal(164n);
    expect(bytes[129]).to.equal(0);
    expect(BigInt(`0x${bytes.subarray(130, 162).toString("hex")}`)).to.equal(2n);
    expect(`0x${bytes.subarray(162, 164).toString("hex")}`).to.equal("0x1234");
    expect(BigInt(`0x${bytes.subarray(164, 196).toString("hex")}`)).to.equal(3n);
    expect(`0x${bytes.subarray(196).toString("hex")}`).to.equal("0xaabbcc");
    expect(() => encodeGuardContractSignatures({ address: primary, payload: "0x1234" }, { address: primary, payload: "0xaabb" })).to.throw();
  });
  it("canonicalizes mixed checksum addresses and uppercase payloads without changing contract-signature bytes", () => {
    const primary = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    const secondary = getAddress("0xbcdefabcdefabcdefabcdefabcdefabcdefabcde");
    for (const useSecondary of [false, true]) {
      const signature = encodeGuardContractSignatures({ address: primary, payload: "0xAABBCC" }, useSecondary ? { address: secondary, payload: "0xDDEEFF00" } : undefined);
      expect(signature).to.match(/^0x[0-9a-f]+$/);
      const bytes = Buffer.from(signature.slice(2), "hex");
      const offset = useSecondary ? 130 : 65;
      expect(`0x${bytes.subarray(12, 32).toString("hex")}`).to.equal(primary.toLowerCase());
      expect(BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`)).to.equal(BigInt(offset));
      expect(bytes[64]).to.equal(0);
      expect(BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`)).to.equal(3n);
      expect(bytes.subarray(offset + 32, offset + 35).toString("hex")).to.equal("aabbcc");
      if (useSecondary) {
        expect(`0x${bytes.subarray(77, 97).toString("hex")}`).to.equal(secondary.toLowerCase());
        expect(BigInt(`0x${bytes.subarray(97, 129).toString("hex")}`)).to.equal(165n);
        expect(bytes[129]).to.equal(0);
        expect(BigInt(`0x${bytes.subarray(165, 197).toString("hex")}`)).to.equal(4n);
        expect(bytes.subarray(197).toString("hex")).to.equal("ddeeff00");
      }
    }
  });
  it("compatibility config exposes only safe, passkey, ECDSA secondary, Delay, and period fields", async () => {
    const artifact = await hre.artifacts.readArtifact("TieredSpendingGuard");
    const constructorAbi = artifact.abi.find((entry) => entry.type === "constructor");
    const constructorFields = constructorAbi?.inputs[0].components.map((component) => component.name);
    expect(constructorFields).to.deep.equal(["safe", "passkey", "ecdsaSecondary", "delay", "periodSeconds", "periodAnchor"]);

    const [deployer, ecdsaSecondary] = await hre.viem.getWalletClients();
    const singleton = await hre.viem.deployContract("Safe");
    const proxy = await hre.viem.deployContract("SafeProxy", [singleton.address]);
    const safe = await hre.viem.getContractAt("Safe", proxy.address);
    const passkey = await hre.viem.deployContract("Mock1271Signer");
    const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [safe.address, safe.address, safe.address, 10n, 60n]);
    const guard = await hre.viem.deployContract("TieredSpendingGuard", [[
      safe.address,
      passkey.address,
      ecdsaSecondary.account.address,
      delay.address,
      86400n,
      0n,
    ]]);
    const owners = [passkey.address, ecdsaSecondary.account.address].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    await safe.write.setup([
      owners,
      1n,
      ZERO,
      "0x",
      ZERO,
      ZERO,
      0n,
      ZERO,
    ], { account: deployer.account });

    const config = await guard.read.config();
    expect(config).to.have.length(6);
    expect(config.map((value) => typeof value)).to.deep.equal(["string", "string", "string", "string", "bigint", "bigint"]);
    expect((await safe.read.getOwners()).map((owner) => owner.toLowerCase())).to.deep.equal(owners.map((owner) => owner.toLowerCase()));
  });

  it("secondary signer config exposes primary, safe-contract secondary, and ECDSA secondary roles", async () => {
    const { guard, passkey, ecdsaSecondary } = await fixture();

    const primary = await guard.read.primarySigner();
    expect(primary[0].toLowerCase()).to.equal(passkey.address.toLowerCase());
    expect(primary[1]).to.equal(0);
    expect(primary[2]).to.equal(0);
    expect(primary[3]).to.equal(true);

    const safeContractSecondary = await guard.read.safeContractSecondary();
    expect(safeContractSecondary[0]).to.equal(ZERO);
    expect(safeContractSecondary[1]).to.equal(0);
    expect(safeContractSecondary[2]).to.equal(false);

    const ecdsaSecondaryConfig = await guard.read.ecdsaSecondary();
    expect(ecdsaSecondaryConfig[0].toLowerCase()).to.equal(ecdsaSecondary.account.address.toLowerCase());
    expect(ecdsaSecondaryConfig[1]).to.equal(1);
    expect(ecdsaSecondaryConfig[2]).to.equal(true);
  });

  it("policy hash binds configured secondary signer drift", async () => {
    const { deployer, ecdsaSecondary, safe, guard } = await fixture();
    const safeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const wrongSafeContractSecondary = await hre.viem.deployContract("Mock1271Signer");
    const ownerCall = async (to: Address, data: Hex) => {
      const signature = await signSafeTransaction(safe, ecdsaSecondary, to, data);
      await safe.write.execTransaction([to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signature], { account: deployer.account });
    };
    const configure = (signer: Address, enabled: boolean) => ownerCall(
      guard.address,
      encodeFunctionData({ abi: configureSafeContractSecondaryAbi, functionName: "configureSafeContractSecondary", args: [signer, enabled] }),
    );

    const unset = await guard.read.policyHash();
    await configure(safeContractSecondary.address, true);
    const enabled = await guard.read.policyHash();
    await configure(wrongSafeContractSecondary.address, true);
    const wrong = await guard.read.policyHash();
    await configure(safeContractSecondary.address, false);
    const disabled = await guard.read.policyHash();

    expect(enabled).not.to.equal(unset);
    expect(wrong).not.to.equal(enabled);
    expect(disabled).not.to.equal(enabled);
  });

  it("reconstructs the Safe hash with the pre-increment nonce and binds every Safe field", async () => {
    const { safe, guard, recipient } = await fixture();
    const data = "0x12345678" as Hex;
    const common = [recipient.account.address, 7n, data, 0, 0n, 0n, 0n, ZERO, ZERO, 0n] as const;
    const expected = await safe.read.getTransactionHash(common);
    expect(await guard.read.computeSafeTransactionHash(common)).to.equal(expected);

    for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const changed = [...common] as unknown[];
      if (index === 0) changed[index] = guard.address;
      else if (index === 1) changed[index] = 8n;
      else if (index === 2) changed[index] = "0x12345679";
      else if (index === 3) changed[index] = 1;
      else if (index === 7 || index === 8) changed[index] = guard.address;
      else changed[index] = (changed[index] as bigint) + 1n;
      expect(await guard.read.computeSafeTransactionHash(changed as never)).to.not.equal(expected);
    }
  });

  it("requires one canonical Safe contract signature naming the configured passkey", async () => {
    const { guard, passkey } = await fixture();
    const valid = `0x${passkey.address.slice(2).padStart(64, "0")}${toHex(65n, { size: 32 }).slice(2)}00${toHex(0n, { size: 32 }).slice(2)}` as Hex;
    const decoded = await guard.read.decodePasskeySignature([valid]);
    expect(decoded[0].toLowerCase()).to.equal(passkey.address.toLowerCase());
    expect(decoded[1]).to.equal(97n);
    await expect(guard.read.decodePasskeySignature(["0x"])).to.be.rejectedWith("Malformed");
    await expect(guard.read.decodePasskeySignature([`${valid}00` as Hex])).to.be.rejectedWith("Trailing");
    const approvedHash = `${valid.slice(0, 130)}01` as Hex;
    await expect(guard.read.decodePasskeySignature([approvedHash])).to.be.rejected;
    const nonCanonical = `0x01${valid.slice(4)}` as Hex;
    await expect(guard.read.decodePasskeySignature([nonCanonical])).to.be.rejected;
  });

  it("uses a terminal typed envelope for the ECDSA secondary signature", async () => {
    const { guard, passkey, ecdsaSecondary } = await fixture();
    const safeSignature = `0x${passkey.address.slice(2).padStart(64, "0")}${toHex(65n, { size: 32 }).slice(2)}00${toHex(0n, { size: 32 }).slice(2)}` as Hex;
    const ecdsaSecondarySignature = `0x${"11".repeat(64)}` as Hex;
    const typeHash = await guard.read.ECDSA_SECONDARY_SIGNATURE_TYPE_HASH();
    const extension = `0x${ecdsaSecondarySignature.slice(2)}${toHex((ecdsaSecondarySignature.length - 2) / 2, { size: 32 }).slice(2)}${typeHash.slice(2)}` as Hex;
    expect(await guard.read.decodeEcdsaSecondaryExtension([`${safeSignature}${extension.slice(2)}` as Hex])).to.equal(ecdsaSecondarySignature);
    await expect(guard.read.decodeEcdsaSecondaryExtension([safeSignature])).to.be.rejectedWith("Missing");
    await expect(guard.read.decodeEcdsaSecondaryExtension([`${safeSignature}${extension.slice(2)}${extension.slice(2)}` as Hex])).to.be.rejected;
  });
});
