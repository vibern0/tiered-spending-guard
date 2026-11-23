import { expect } from "chai";
import hre from "hardhat";
import { time, takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
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
  moduleArtifact,
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
    const sponsor = async (nonce: bigint, callData: Hex) => {
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
      return {
        ...operation,
        paymasterAndData: concatHex([
          pmHead,
          await sponsorSigner.signMessage({ message: { raw: sponsorHash } }),
        ]),
      };
    };
    const op = async (
      nonce: bigint,
      amount: bigint,
      stepUp: boolean,
      variation: {
        queue?: boolean;
        cancelHead?: bigint;
        signingDelay?: Address;
        recipient?: Address;
        token?: Address;
        guard?: Address;
        validUntil?: number;
        chainId?: number;
        signingRouter?: Address;
        signingGuard?: Address;
      } = {},
    ) => {
      const cancel = variation.cancelHead !== undefined;
      const delayAction = cancel ? "CancelWithdrawal" : "QueueWithdrawal";
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
            { type: "uint8" },
            { type: "uint48" },
          ],
          [
            variation.guard ?? f.guard.address,
            variation.token ?? f.token.address,
            variation.recipient ?? destination,
            amount,
            cancel ? 3 : variation.queue ? 2 : Number(stepUp),
            variation.validUntil ?? (await time.latest()) + 300,
          ],
        ),
        cancel ? toHex(variation.cancelHead!, { size: 32 }) : "0x",
      ]);
      const sponsored = await sponsor(nonce, callData);
      const userOpHash = (await entry.read.getUserOpHash([sponsored])) as Hex;
      const domain = {
        name: "GLD Instant Send",
        version: "1",
        chainId: variation.chainId ?? 31337,
        verifyingContract: variation.signingRouter ?? f.router.address,
      } as const;
      const message = {
        userOpHash,
        guard: variation.signingGuard ?? f.guard.address,
      };
      const digest =
        variation.queue || cancel
          ? hashTypedData({
              domain,
              primaryType: delayAction,
              types: {
                [delayAction]: [
                  { name: "userOpHash", type: "bytes32" },
                  { name: "guard", type: "address" },
                  { name: "delay", type: "address" },
                ],
              },
              message: {
                ...message,
                delay: variation.signingDelay ?? f.delay.address,
              },
            })
          : hashTypedData({
              domain,
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
    const beforeQueue = await takeSnapshot();
    const withdrawal = parseEther("20");
    await bundle([await op(2n, withdrawal, true, { queue: true })], [true]);
    const created = await f.delay.read.txCreatedAt([0n]);
    const transfer = encodeFunctionData({
      abi: f.token.abi,
      functionName: "transfer",
      args: [destination, withdrawal],
    });
    const ready = encodeFunctionData({
      abi: f.delay.abi,
      functionName: "executeNextTx",
      args: [f.token.address, 0n, transfer, 0],
    });
    const execute = async (nonce: bigint) => {
      const callData = encodeFunctionData({
        abi: moduleArtifact.abi,
        functionName: "executeUserOp",
        args: [f.delay.address, 0n, ready, 0],
      });
      const sponsored = await sponsor(nonce, callData);
      const prefix = toHex(0n, { size: 12 });
      const digest = await client.readContract({
        address: f.router.address,
        abi: moduleArtifact.abi,
        functionName: "getOperationHash",
        args: [{ ...sponsored, signature: prefix }],
      });
      return {
        ...sponsored,
        signature: concatHex([
          prefix,
          slot(f.primary, signWebAuthn(f.credential, digest)),
        ]),
      };
    };
    const pendingQueue = await takeSnapshot();
    // The entries deliberately have the same token, recipient and amount.
    await bundle([await op(3n, withdrawal, true, { queue: true })], [true]);
    const cancel = (nonce: bigint, head: bigint) =>
      op(nonce, withdrawal, true, { cancelHead: head });
    const validCancel = await cancel(4n, 0n);
    const queueProof = await op(4n, withdrawal, true, { queue: true });
    for (const invalid of [
      await op(4n, withdrawal, false, { cancelHead: 0n }),
      await op(4n, withdrawal, true, {
        cancelHead: 0n,
        signingDelay: f.safe.address,
      }),
      { ...validCancel, signature: queueProof.signature },
      { ...queueProof, signature: validCancel.signature },
    ])
      await expect(entry.write.handleOps([[invalid], bundler.account.address]))
        .to.be.rejected;
    await bundle(
      [
        await op(4n, withdrawal + 1n, true, { cancelHead: 0n }),
        await cancel(5n, 1n),
        await cancel(6n, 0n),
        await cancel(7n, 0n),
      ],
      [false, false, true, false],
    );
    expect(await f.delay.read.txNonce()).to.equal(1n);
    expect(await f.delay.read.queueNonce()).to.equal(2n);
    expect(await spent()).to.equal(parseEther("10.1"));
    expect(await f.token.read.balanceOf([destination])).to.equal(
      parseEther("10.1"),
    );
    const cancelReady = await cancel(8n, 1n);
    await time.setNextBlockTimestamp(
      (await f.delay.read.txCreatedAt([1n])) + 120n,
    );
    await bundle([cancelReady], [true]);
    expect(await f.delay.read.txNonce()).to.equal(2n);
    await expect(
      entry.write.handleOps([[validCancel], bundler.account.address]),
    ).to.be.rejected;
    await pendingQueue.restore();
    const early = await execute(3n);
    await time.setNextBlockTimestamp(created + 119n);
    await bundle([early], [false]);
    expect(await f.delay.read.txNonce()).to.equal(0n);
    expect(await f.token.read.balanceOf([destination])).to.equal(
      parseEther("10.1"),
    );
    const onTime = await execute(4n);
    await time.setNextBlockTimestamp(created + 120n);
    await bundle([onTime], [true]);
    expect(await f.delay.read.txNonce()).to.equal(1n);
    expect(await f.token.read.balanceOf([destination])).to.equal(
      parseEther("30.1"),
    );
    expect(await spent()).to.equal(parseEther("10.1"));
    await bundle([await execute(5n)], [false]);
    await pendingQueue.restore();
    await time.setNextBlockTimestamp(created + 721n);
    await bundle([early], [false]);
    expect(await f.delay.read.txNonce()).to.equal(0n);
    await bundle([await op(4n, withdrawal, true, { cancelHead: 0n })], [true]);
    expect(await f.delay.read.txNonce()).to.equal(1n);
    await beforeQueue.restore();
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
    const amount = parseEther("20.1");
    const queue = await op(8n, amount, true, { queue: true });
    const instant = await op(8n, amount, true);
    for (const invalid of [
      await op(8n, amount, false, { queue: true }),
      await op(8n, amount, true, { queue: true, signingDelay: f.safe.address }),
      { ...queue, signature: instant.signature },
      { ...instant, signature: queue.signature },
    ])
      await expect(entry.write.handleOps([[invalid], bundler.account.address]))
        .to.be.rejected;
    await bundle(
      [queue, await op(9n, parseEther("20"), true, { queue: true })],
      [true, false],
    );
    expect(await f.delay.read.queueNonce()).to.equal(1n);
    expect(await spent()).to.equal(parseEther("10"));
    await expect(entry.write.handleOps([[queue], bundler.account.address])).to
      .be.rejected;
    const expired = await op(10n, 1n, true);
    await time.increase(301);
    await expect(entry.write.handleOps([[expired], bundler.account.address])).to
      .be.rejected;
    expect(await entry.read.balanceOf([f.safe.address])).to.equal(0n);
    expect(await client.getBalance({ address: f.safe.address })).to.equal(0n);
  });
});
