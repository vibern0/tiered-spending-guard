import { createPublicClient, http, parseAbi, type Address } from "viem";
import { sepolia } from "viem/chains";
import {
  PWA_IDENTITY_PROVIDERS,
  captureUsdcIdentity,
  validateUsdc,
  type UsdcIdentityClient,
} from "../../src/pwa/profile";

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const identityClient = (source: string): UsdcIdentityClient => {
  const client = createPublicClient({ chain: sepolia, transport: http(source, { retryCount: 0 }) });
  return Object.freeze({
    source,
    getChainId: () => client.getChainId(),
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: async ({ blockNumber }) => {
      const block = await client.getBlock({ blockNumber });
      return { number: block.number, hash: block.hash };
    },
    getCode: ({ address, blockNumber }) => client.getCode({ address, blockNumber }),
    readContract: ({ address, functionName, blockNumber }) => client.readContract({
      address: address as Address,
      abi: ERC20_ABI,
      functionName,
      blockNumber,
    }),
  });
};

async function main(): Promise<void> {
  const [clientA, clientB] = PWA_IDENTITY_PROVIDERS.map(identityClient) as [UsdcIdentityClient, UsdcIdentityClient];
  const [headA, headB] = await Promise.all([clientA.getBlockNumber(), clientB.getBlockNumber()]);
  const minimumHead = headA < headB ? headA : headB;
  if (minimumHead < 6n) throw new Error("Sepolia providers have no six-confirmation capture block");
  const identity = await captureUsdcIdentity(clientA, clientB, minimumHead - 5n);
  validateUsdc(identity);
  process.stdout.write(`${JSON.stringify({
    token: identity.token,
    runtimeCodeHash: identity.runtimeCodeHash,
    name: identity.name,
    symbol: identity.symbol,
    decimals: identity.decimals,
    identityReview: {
      blockNumber: identity.blockNumber.toString(),
      blockHash: identity.blockHash,
      confirmations: identity.confirmations,
      providers: identity.providers,
    },
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "USDC identity capture failed"}\n`);
  process.exitCode = 1;
});
