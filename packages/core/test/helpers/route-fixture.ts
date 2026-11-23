import { expect } from "chai";
import hre from "hardhat";
import {
  concatHex,
  encodeFunctionData,
  getContract,
  keccak256,
  padHex,
  parseEther,
  size,
  toHex,
  zeroAddress,
  type Hex,
  type Address,
} from "viem";
import {
  createAutomatedCredential,
  signWebAuthn,
} from "../../scripts/live/webauthn";

export const safeArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json");
const proxyArtifact = require("@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json");
export const moduleArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json");
const setupArtifact = require("@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json");
const signerFactoryArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json");
const verifierArtifact = require("@safe-global/safe-passkey/build/artifacts/contracts/verifiers/FCLP256Verifier.sol/FCLP256Verifier.json");
export const entryPointArtifact = require("@account-abstraction/contracts/artifacts/EntryPoint.json");
export const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;

export function slot(owner: Address, payload: Hex): Hex {
  return concatHex([
    padHex(owner, { size: 32 }),
    toHex(65n, { size: 32 }),
    "0x00",
    toHex(size(payload), { size: 32 }),
    payload,
  ]);
}

export async function routeFixture(
  sponsor?: Address,
  supply = parseEther("1000"),
) {
  const [payer, recipient] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  const deploy = async (a: any, args: readonly unknown[] = []) => {
    const hash = await payer.deployContract({
      abi: a.abi,
      bytecode: a.bytecode,
      args,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).to.equal("success");
    return getContract({
      address: receipt.contractAddress!,
      abi: a.abi,
      client: { public: client, wallet: payer },
    });
  };
  const verifier = await deploy(verifierArtifact);
  const signerFactory = await deploy(signerFactoryArtifact);
  const credential = createAutomatedCredential();
  const signerArgs = [
    credential.x,
    credential.y,
    BigInt(verifier.address),
  ] as const;
  await signerFactory.write.createSigner(signerArgs);
  const primary = (await signerFactory.read.getSigner(signerArgs)) as Address;
  const secondaryCredential = createAutomatedCredential();
  const secondaryArgs = [
    secondaryCredential.x,
    secondaryCredential.y,
    BigInt(verifier.address),
  ] as const;
  await signerFactory.write.createSigner(secondaryArgs);
  const secondary = (await signerFactory.read.getSigner(
    secondaryArgs,
  )) as Address;
  const module = await deploy(moduleArtifact, [EP]);
  const setup = await deploy(setupArtifact);
  const singleton = await deploy(safeArtifact);
  const proxy = await deploy(proxyArtifact, [singleton.address]);
  const safe = getContract({
    address: proxy.address,
    abi: safeArtifact.abi,
    client: { public: client, wallet: payer },
  });
  const token = await hre.viem.deployContract("ERC20Mock", [
    safe.address,
    supply,
  ]);
  const router = sponsor
    ? await hre.viem.deployContract("Safe4337InstantRouter", [
        safe.address,
        module.address,
        EP,
        token.address,
        sponsor,
      ])
    : await hre.viem.deployContract("Safe4337RestrictedRouter", [
        safe.address,
        module.address,
        EP,
      ]);
  const routerHash = keccak256(
    (await client.getCode({ address: router.address }))!,
  );
  const setupData = encodeFunctionData({
    abi: setup.abi,
    functionName: "enableModules",
    args: [[router.address]],
  });
  await safe.write.setup([
    [primary],
    1n,
    setup.address,
    setupData,
    router.address,
    zeroAddress,
    0n,
    zeroAddress,
  ]);
  const delay = await hre.viem.deployContract("ZodiacDelayV1_1_1", [
    safe.address,
    safe.address,
    safe.address,
    120n,
    600n,
  ]);
  const guard = await hre.viem.deployContract("TieredSpendingGuard4337", [
    [safe.address, primary, zeroAddress, delay.address, 86400n, 0n],
    routerHash,
  ]);
  const wrongGuard = await hre.viem.deployContract("TieredSpendingGuard4337", [
    [safe.address, primary, zeroAddress, delay.address, 86400n, 0n],
    keccak256("0x01"),
  ]);
  const ownerCall = async (to: Address, value: bigint, data: Hex) => {
    const nonce = await safe.read.nonce();
    const digest = await safe.read.getTransactionHash([
      to,
      value,
      data,
      0,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      nonce,
    ]);
    return safe.write.execTransaction([
      to,
      value,
      data,
      0,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      slot(primary, signWebAuthn(credential, digest)),
    ]);
  };

  await expect(
    ownerCall(
      wrongGuard.address,
      0n,
      encodeFunctionData({
        abi: wrongGuard.abi,
        functionName: "configureAaRouter",
        args: [router.address],
      }),
    ),
  ).to.be.rejected;
  await ownerCall(
    guard.address,
    0n,
    encodeFunctionData({
      abi: guard.abi,
      functionName: "configureAaRouter",
      args: [router.address],
    }),
  );
  await ownerCall(
    guard.address,
    0n,
    encodeFunctionData({
      abi: guard.abi,
      functionName: "setAssetPolicy",
      args: [
        token.address,
        parseEther("10"),
        parseEther("30"),
        parseEther("10"),
        parseEther("30"),
        [recipient.account.address],
      ],
    }),
  );
  await ownerCall(
    guard.address,
    0n,
    encodeFunctionData({
      abi: guard.abi,
      functionName: "configureSafeContractSecondary",
      args: [secondary, true],
    }),
  );
  await ownerCall(
    safe.address,
    0n,
    encodeFunctionData({
      abi: safeArtifact.abi,
      functionName: "enableModule",
      args: [delay.address],
    }),
  );
  await ownerCall(
    delay.address,
    0n,
    encodeFunctionData({
      abi: delay.abi,
      functionName: "enableModule",
      args: [safe.address],
    }),
  );
  await ownerCall(
    safe.address,
    0n,
    encodeFunctionData({
      abi: safeArtifact.abi,
      functionName: "setModuleGuard",
      args: [guard.address],
    }),
  );
  await ownerCall(
    safe.address,
    0n,
    encodeFunctionData({
      abi: safeArtifact.abi,
      functionName: "setGuard",
      args: [guard.address],
    }),
  );
  await ownerCall(
    guard.address,
    0n,
    encodeFunctionData({
      abi: guard.abi,
      functionName: "addRouteOnlyTarget",
      args: [token.address],
    }),
  );

  return {
    payer,
    recipient,
    client,
    deploy,
    credential,
    primary,
    secondaryCredential,
    secondary,
    module,
    safe,
    router,
    delay,
    guard,
    token,
    ownerCall,
  };
}
