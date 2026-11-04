import { isAddressEqual, type Address, type Hex } from "viem";
import type { PwaProvisioningAutomationPolicy } from "./authorization";
import type { PwaProvisioningTransaction } from "./provisioning";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const BPS = 10_000n;

export type PwaProvisioningQuoteClient = Readonly<{
  source: string;
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(input: Readonly<{ blockNumber: bigint }>): Promise<Readonly<{
    number: bigint;
    hash: Hex | null;
    baseFeePerGas: bigint | null;
    gasLimit: bigint;
  }>>;
  getTransactionCount(input: Readonly<{ address: Address; blockNumber?: bigint; blockTag?: "latest" | "pending" }>): Promise<bigint | number>;
  estimateGas(input: Readonly<{ account: Address; to?: Address; data: Hex; value: bigint; blockNumber: bigint }>): Promise<bigint>;
  getMaxPriorityFeePerGas(): Promise<bigint>;
}>;

export type PwaProvisioningQuote = Readonly<{
  blockNumber: bigint;
  blockHash: Hex;
  blockGasLimit: bigint;
  baseFeePerGas: bigint;
  estimates: readonly [bigint, bigint];
  priorityFeesPerGas: readonly [bigint, bigint];
  providers: readonly [string, string];
}>;

export async function collectPwaProvisioningQuote(input: Readonly<{
  transaction: PwaProvisioningTransaction;
  deployer: Address;
  providers: readonly [PwaProvisioningQuoteClient, PwaProvisioningQuoteClient];
  relay: Pick<PwaProvisioningQuoteClient, "getBlock" | "getTransactionCount">;
  policy: Pick<PwaProvisioningAutomationPolicy, "chainId" | "maxEstimateDivergenceBps" | "maxHeadLagBlocks">;
}>): Promise<PwaProvisioningQuote> {
  const [left, right] = input.providers;
  if (!left.source || !right.source || left.source === right.source) throw new Error("provisioning quote providers must be distinct");
  const [leftChain, rightChain, leftHead, rightHead] = await Promise.all([
    left.getChainId(), right.getChainId(), left.getBlockNumber(), right.getBlockNumber(),
  ]);
  if (leftChain !== input.policy.chainId || rightChain !== input.policy.chainId) throw new Error("provisioning quote chain mismatch");
  const blockNumber = leftHead < rightHead ? leftHead : rightHead;
  const highHead = leftHead > rightHead ? leftHead : rightHead;
  if (highHead - blockNumber > input.policy.maxHeadLagBlocks) throw new Error("provisioning quote provider head lag exceeds policy");
  const [leftBlock, rightBlock, relayBlock] = await Promise.all([
    left.getBlock({ blockNumber }), right.getBlock({ blockNumber }), input.relay.getBlock({ blockNumber }),
  ]);
  if (leftBlock.number !== blockNumber || rightBlock.number !== blockNumber || relayBlock.number !== blockNumber) throw new Error("provisioning quote block number mismatch");
  if (!leftBlock.hash || !rightBlock.hash || !relayBlock.hash) throw new Error("provisioning quote block hash is missing");
  if (leftBlock.hash.toLowerCase() !== rightBlock.hash.toLowerCase() || leftBlock.hash.toLowerCase() !== relayBlock.hash.toLowerCase()) throw new Error("provisioning quote block hash mismatch");
  if (leftBlock.baseFeePerGas === null || rightBlock.baseFeePerGas === null) throw new Error("provisioning quote base fee is missing");
  if (leftBlock.baseFeePerGas !== rightBlock.baseFeePerGas) throw new Error("provisioning quote base fee mismatch");
  if (leftBlock.gasLimit <= 0n || leftBlock.gasLimit !== rightBlock.gasLimit) throw new Error("provisioning quote block gas limit mismatch");

  const [leftNonceRaw, rightNonceRaw, relayLatestRaw, relayPendingRaw] = await Promise.all([
    left.getTransactionCount({ address: input.deployer, blockNumber }),
    right.getTransactionCount({ address: input.deployer, blockNumber }),
    input.relay.getTransactionCount({ address: input.deployer, blockTag: "latest" }),
    input.relay.getTransactionCount({ address: input.deployer, blockTag: "pending" }),
  ]);
  const expectedNonce = input.transaction.nonce;
  if (BigInt(leftNonceRaw) !== expectedNonce || BigInt(rightNonceRaw) !== expectedNonce) throw new Error(`provisioning quote nonce mismatch for ${input.transaction.id}: expected ${expectedNonce}, identity provider 1 observed ${leftNonceRaw}, identity provider 2 observed ${rightNonceRaw}`);
  if (BigInt(relayLatestRaw) !== expectedNonce || BigInt(relayPendingRaw) !== expectedNonce) throw new Error(`provisioning relay nonce mismatch for ${input.transaction.id}: expected ${expectedNonce}, latest observed ${relayLatestRaw}, pending observed ${relayPendingRaw}`);

  const transactionInput = {
    account: input.deployer,
    ...(isAddressEqual(input.transaction.to, ZERO) ? {} : { to: input.transaction.to }),
    data: input.transaction.data,
    value: input.transaction.value,
    blockNumber,
  } as const;
  const [leftEstimate, rightEstimate, leftTip, rightTip] = await Promise.all([
    left.estimateGas(transactionInput), right.estimateGas(transactionInput), left.getMaxPriorityFeePerGas(), right.getMaxPriorityFeePerGas(),
  ]);
  if (leftEstimate <= 0n || rightEstimate <= 0n) throw new Error("provisioning quote estimate is invalid");
  const highEstimate = leftEstimate > rightEstimate ? leftEstimate : rightEstimate;
  const lowEstimate = leftEstimate < rightEstimate ? leftEstimate : rightEstimate;
  if ((highEstimate - lowEstimate) * BPS > highEstimate * input.policy.maxEstimateDivergenceBps) throw new Error("provisioning quote estimates diverge");
  if (leftTip < 0n || rightTip < 0n) throw new Error("provisioning quote priority fee is invalid");

  return Object.freeze({
    blockNumber,
    blockHash: leftBlock.hash,
    blockGasLimit: leftBlock.gasLimit,
    baseFeePerGas: leftBlock.baseFeePerGas,
    estimates: Object.freeze([leftEstimate, rightEstimate]) as readonly [bigint, bigint],
    priorityFeesPerGas: Object.freeze([leftTip, rightTip]) as readonly [bigint, bigint],
    providers: Object.freeze([left.source, right.source]) as readonly [string, string],
  });
}
