import { expect } from "chai";
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  getContract,
  hashTypedData,
  parseEther,
  parseEventLogs,
  toHex,
  toFunctionSelector,
  type Hex,
  type Address,
} from "viem";
import { signWebAuthn } from "../../scripts/live/webauthn";
import {
  routeFixture,
  EP,
  slot,
  entryPointArtifact,
} from "../helpers/route-fixture";

describe("sponsored single-assertion GLD route", () => {
  it("checks the current tier per execution, atomically, for signed operations in one EntryPoint bundle", async () => {
    const [bundler, sponsorSigner] = await hre.viem.getWalletClients();
    const client = await hre.viem.getPublicClient();
    const deployArtifact = async (
      artifact: typeof entryPointArtifact,
      args: readonly unknown[],
    ) => {
      const tx = await bundler.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        args,
      });
      const { contractAddress } = await client.waitForTransactionReceipt({
        hash: tx,
      });
      return getContract({
        address: contractAddress!,
        abi: artifact.abi,
        client: { public: client, wallet: bundler },
      });
    };
    const implementation = await deployArtifact(entryPointArtifact, []);
    await hre.network.provider.send("hardhat_setCode", [
      EP,
      await client.getCode({ address: implementation.address }),
    ]);
    const entry = getContract({
      address: EP,
      abi: entryPointArtifact.abi,
      client: { public: client, wallet: bundler },
    });
    const pm = await deployArtifact(
      require("@account-abstraction/contracts/artifacts/VerifyingPaymaster.json"),
      [EP, sponsorSigner.account.address],
    );
    await entry.write.depositTo([pm.address], { value: parseEther("1") });
    const f = await routeFixture(pm.address, parseEther("40"));
    const destination = f.recipient.account.address;
    const nextDay = async () =>
      time.increaseTo((Math.floor((await time.latest()) / 86400) + 1) * 86400);
    await nextDay();
    const op = async (
      nonce: bigint,
      amount: bigint,
      stepUp: boolean,
      variation: {
        recipient?: Address;
        token?: Address;
        guard?: Address;
        validUntil?: number;
        chainId?: number;
        signingRouter?: Address;
        signingGuard?: Address;
      } = {},
    ) => {
      const callData = concatHex([
        toFunctionSelector(
          "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
        ),
        encodeAbiParameters(
          [
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
            { type: "bool" },
            { type: "uint48" },
          ],
          [
            variation.guard ?? f.guard.address,
            variation.token ?? f.token.address,
            variation.recipient ?? destination,
            amount,
            stepUp,
            variation.validUntil ?? (await time.latest()) + 300,
          ],
        ),
      ]);
      const pmHead = concatHex([
        pm.address,
        toHex(200000n, { size: 16 }),
        toHex(150000n, { size: 16 }),
        encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [0, 0]),
      ]);
      const operation = {
        sender: f.safe.address,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits: toHex((2200000n << 128n) | 2000000n, { size: 32 }),
        preVerificationGas: 200000n,
        gasFees: toHex((1000000000n << 128n) | 2000000000n, { size: 32 }),
        paymasterAndData: pmHead,
        signature: "0x",
      } as const;
      const sponsorHash = (await pm.read.getHash([operation, 0, 0])) as Hex;
      const sponsored = {
        ...operation,
        paymasterAndData: concatHex([
          pmHead,
          await sponsorSigner.signMessage({ message: { raw: sponsorHash } }),
        ]),
      };
      const userOpHash = (await entry.read.getUserOpHash([sponsored])) as Hex;
      const digest = hashTypedData({
        domain: {
          name: "GLD Instant Send",
          version: "1",
          chainId: variation.chainId ?? 31337,
          verifyingContract: variation.signingRouter ?? f.router.address,
        },
        types: {
          InstantSend: [
            { name: "userOpHash", type: "bytes32" },
            { name: "guard", type: "address" },
          ],
        },
        primaryType: "InstantSend",
        message: {
          userOpHash,
          guard: variation.signingGuard ?? f.guard.address,
        },
      });
      const signature = encodeAbiParameters(
        [{ type: "bytes" }, { type: "bytes" }],
        [
          slot(f.primary, signWebAuthn(f.credential, digest)),
          stepUp ? signWebAuthn(f.secondaryCredential, digest) : "0x",
        ],
      );
      return { ...sponsored, signature };
    };
    type Signed = Awaited<ReturnType<typeof op>>;
    const bundle = async (ops: Signed[], expected: boolean[]) => {
      const hash = await entry.write.handleOps([ops, bundler.account.address], {
        gas: 16500000n,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).to.equal("success");
      const events = parseEventLogs({
        abi: entryPointArtifact.abi,
        logs: receipt.logs,
        eventName: "UserOperationEvent",
      });
      expect(events.map((e: any) => e.args.success)).to.deep.equal(expected);
      for (const e of events as any[]) {
        expect(e.args.paymaster.toLowerCase()).to.equal(
          pm.address.toLowerCase(),
        );
        expect(e.args.actualGasCost > 0n).to.equal(true);
      }
      expect(await f.guard.read.instantFinished()).to.equal(true);
    };
    const spent = async () =>
      (await f.guard.read.spendState([f.token.address]))[2];
    const first = await op(0n, parseEther("1"), false);
    const second = await op(1n, parseEther("9.1"), true);
    // Each validation precedes both executions. Neither approval may overwrite or carry into the other.
    await bundle([first, second], [true, true]);
    expect(await spent()).to.equal(parseEther("10.1"));
    expect(await f.token.read.balanceOf([destination])).to.equal(
      parseEther("10.1"),
    );
    await bundle(
      [
        await op(2n, 1n, false),
        await op(3n, parseEther("19.9"), true),
        await op(4n, 1n, true),
      ],
      [false, true, false],
    );
    expect(await spent()).to.equal(parseEther("30"));
    expect(await f.token.read.balanceOf([destination])).to.equal(
      parseEther("30"),
    );
    await expect(entry.write.handleOps([[first], bundler.account.address])).to
      .be.rejected;

    await nextDay();
    await bundle(
      [await op(5n, parseEther("10"), false), await op(6n, 1n, false)],
      [true, false],
    );
    expect(await spent()).to.equal(parseEther("10"));
    const next = await op(7n, 1n, true);
    const other = await op(7n, 2n, true);
    const proofs = [{ type: "bytes" }, { type: "bytes" }] as const;
    const [primary, secondary] = decodeAbiParameters(proofs, next.signature);
    const changedRecipient = await op(7n, 1n, true, {
      recipient: bundler.account.address,
    });
    const changedValidity = await op(7n, 1n, true, {
      validUntil: (await time.latest()) + 500,
    });
    const changedTier = await op(7n, 1n, false);

    for (const invalid of [
      { ...next, signature: other.signature },
      { ...changedRecipient, signature: next.signature },
      { ...changedValidity, signature: next.signature },
      { ...changedTier, signature: next.signature },
      await op(7n, 1n, true, { token: pm.address }),
      await op(7n, 1n, true, { guard: pm.address }),
      await op(7n, 1n, true, { chainId: 1 }),
      await op(7n, 1n, true, { signingRouter: pm.address }),
      await op(7n, 1n, true, { signingGuard: pm.address }),
      {
        ...next,
        signature: encodeAbiParameters(proofs, [
          slot(f.secondary, secondary),
          secondary,
        ]),
      },
      { ...next, signature: encodeAbiParameters(proofs, [primary, "0x"]) },
      { ...next, paymasterAndData: "0x" },
      { ...next, gasFees: toHex(0n, { size: 32 }) },
    ])
      await expect(entry.write.handleOps([[invalid], bundler.account.address]))
        .to.be.rejected;
    expect(await spent()).to.equal(parseEther("10"));
    // The Safe spent its 40 GLD across the two days. A valid step-up now fails at token execution.
    await bundle([next], [false]);
    expect(await spent()).to.equal(parseEther("10"));
    expect(await f.token.read.balanceOf([destination])).to.equal(
      parseEther("40"),
    );
    const expired = await op(8n, 1n, true);
    await time.increase(301);
    await expect(entry.write.handleOps([[expired], bundler.account.address])).to
      .be.rejected;
    expect(await entry.read.balanceOf([f.safe.address])).to.equal(0n);
    expect(await client.getBalance({ address: f.safe.address })).to.equal(0n);
  });
});
