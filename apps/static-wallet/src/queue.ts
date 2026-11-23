import {
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  keccak256,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { dayStart } from "./transfer";

const added = parseAbiItem(
  "event TransactionAdded(uint256 indexed queueNonce,bytes32 indexed txHash,address to,uint256 value,bytes data,uint8 operation)",
);
const moduleSuccess = parseAbiItem(
  "event ExecutionFromModuleSuccess(address indexed module)",
);
const transfer = parseAbiItem(
  "event Transfer(address indexed from,address indexed to,uint256 value)",
);
const delayAbi = parseAbi([
  "function txNonce() view returns(uint256)",
  "function queueNonce() view returns(uint256)",
  "function txHash(uint256) view returns(bytes32)",
  "function txCreatedAt(uint256) view returns(uint256)",
  "function txCooldown() view returns(uint256)",
  "function txExpiration() view returns(uint256)",
]);
export type Queued = {
  nonce: bigint;
  hash: Hex;
  calldata: Hex;
  amount: bigint;
  recipient: Address;
  readyAt: bigint;
  expiresAt: bigint;
};
export function queueStatus(item: Queued, now: bigint) {
  if (now < item.readyAt) return "waiting";
  return now > item.expiresAt ? "expired" : "ready";
}

export async function readQueue(
  client: PublicClient,
  delay: Address,
  token: Address,
  recipient: Address,
  blockNumber: bigint,
): Promise<Queued[]> {
  const contract = { address: delay, abi: delayAbi, blockNumber } as const;
  const [head, tail, cooldown, expiration] = await Promise.all([
    client.readContract({ ...contract, functionName: "txNonce" }),
    client.readContract({ ...contract, functionName: "queueNonce" }),
    client.readContract({ ...contract, functionName: "txCooldown" }),
    client.readContract({ ...contract, functionName: "txExpiration" }),
  ]);
  if (head === tail) return [];
  const logs = await client.getLogs({
    address: delay,
    event: added,
    fromBlock: 0n,
    toBlock: blockNumber,
    strict: true,
  });
  const active = logs.filter(
    (log) => log.args.queueNonce >= head && log.args.queueNonce < tail,
  );
  if (BigInt(active.length) !== tail - head)
    throw Error("Cannot verify all pending withdrawals.");
  return Promise.all(
    active.map(async ({ args }, index) => {
      const nonce = head + BigInt(index);
      const [stored, created] = await Promise.all([
        client.readContract({
          ...contract,
          functionName: "txHash",
          args: [nonce],
        }),
        client.readContract({
          ...contract,
          functionName: "txCreatedAt",
          args: [nonce],
        }),
      ]);
      const hash = keccak256(
        encodePacked(
          ["address", "uint256", "bytes", "uint8"],
          [args.to, args.value, args.data, args.operation],
        ),
      );
      if (
        args.queueNonce !== nonce ||
        args.txHash !== hash ||
        stored !== hash ||
        args.to.toLowerCase() !== token.toLowerCase() ||
        args.value !== 0n ||
        args.operation !== 0 ||
        created === 0n
      )
        throw Error("Queued action does not match the reviewed GLD transfer.");
      const call = decodeFunctionData({ abi: erc20Abi, data: args.data });
      if (
        call.functionName !== "transfer" ||
        call.args[0].toLowerCase() !== recipient.toLowerCase() ||
        call.args[1] <= 0n ||
        encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: call.args,
        }) !== args.data
      )
        throw Error("Unrecognized queued token call.");
      return {
        nonce,
        hash,
        calldata: args.data,
        amount: call.args[1],
        recipient: call.args[0],
        readyAt: created + cooldown,
        expiresAt: created + cooldown + expiration,
      };
    }),
  );
}

// For the pinned GLD mock, transfer emits exactly one log before the Safe records
// the successful Delay module call. Match log positions even in multi-operation bundles.
export async function delayedUsage(
  client: PublicClient,
  safe: Address,
  delay: Address,
  token: Address,
  recipient: Address,
  blockNumber: bigint,
  now: bigint,
) {
  const successes = await client.getLogs({
    address: safe,
    event: moduleSuccess,
    args: { module: delay },
    fromBlock: 0n,
    toBlock: blockNumber,
    strict: true,
  });
  if (!successes.length) return 0n;
  const transfers = await client.getLogs({
    address: token,
    event: transfer,
    args: { from: safe, to: recipient },
    fromBlock: successes[0].blockNumber,
    toBlock: blockNumber,
    strict: true,
  });
  const amounts = new Map(
    transfers.map((l) => [`${l.transactionHash}:${l.logIndex}`, l.args.value]),
  );
  let total = 0n;
  for (const log of successes) {
    const amount = amounts.get(`${log.transactionHash}:${log.logIndex - 1}`);
    if (
      amount &&
      (await client.getBlock({ blockHash: log.blockHash })).timestamp >=
        dayStart(now)
    )
      total += amount;
  }
  return total;
}
