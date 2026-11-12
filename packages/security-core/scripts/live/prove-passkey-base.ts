import { createPublicClient, encodeFunctionData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { encodeSafeContractSignature } from "../../src/signers/passkey-helpers";
import { loadCredential, loadFundingKey } from "./secrets";
import { createLiveJournalStore, createSepoliaLiveContext } from "./runtime";
import { submitLiveIntent, type LiveIntent } from "./submission";
import { signWebAuthn } from "./webauthn";

const directory = "/Users/bernardo/.local/share/tiered-spending-guard/sepolia";
const safe = "0x0129cba52b1f0b929f2a9a971fff841f5228ff4e" as const;
const primary = "0x6F9c2f4f8526A17f38c9409a8cBF605b34Fa146c" as const;
const zero = "0x0000000000000000000000000000000000000000" as const;
const amount = 10_000_000_000_000n;
const safeAbi = [
  { name: "nonce", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "getTransactionHash", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "bytes32" }] },
  { name: "execTransaction", type: "function", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes" }], outputs: [{ type: "bool" }] },
] as const;

async function main(): Promise<void> {
  const repository = process.cwd().replace(/\/packages\/security-core$/, "");
  const account = privateKeyToAccount(loadFundingKey(`${directory}/funding-key`, repository));
  const credential = loadCredential(`${directory}/primary-passkey.json`, repository);
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
  const journal = createLiveJournalStore(`${directory}/passkey-base-proof.json`, account.address);
  try {
    const live = createSepoliaLiveContext({ account, client, verify: async () => { if (await client.getChainId() !== sepolia.id) throw new Error("wrong chain"); }, persist: async value => journal.save(value) });
    const submit = async (input: Omit<LiveIntent, "gas" | "maxFeePerGas" | "maxPriorityFeePerGas">) => {
      const fees = await client.estimateFeesPerGas();
      const estimated = await client.estimateGas({ account, to: input.to, data: input.data, value: input.value });
      const intent: LiveIntent = { ...input, gas: estimated + estimated / 5n, maxFeePerGas: fees.maxFeePerGas ?? 2_000_000n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1_000_000n };
      let entry = await submitLiveIntent(intent, journal.load(), live);
      if (entry.status === "pending") {
        await client.waitForTransactionReceipt({ hash: entry.transactionHash, confirmations: 1, timeout: 120_000 });
        entry = await submitLiveIntent(intent, journal.load(), live);
      }
      if (entry.status !== "success") throw new Error(`${input.id} did not succeed`);
      return entry;
    };

    const funding = await submit({ id: "fund-passkey-safe", to: safe, data: "0x", value: amount, nonce: await live.nonce() });
    const safeNonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const digest = await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [account.address, amount, "0x", 0, 0n, 0n, 0n, zero, zero, safeNonce] });
    const signature = encodeSafeContractSignature(primary, signWebAuthn(credential, digest));
    const data = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [account.address, amount, "0x", 0, 0n, 0n, 0n, zero, zero, signature] });
    const execution = await submit({ id: "passkey-base-native", to: safe, data, value: 0n, nonce: await live.nonce() });
    console.log(JSON.stringify({ safe, funding: funding.transactionHash, execution: execution.transactionHash, amount: amount.toString() }));
  } finally {
    journal.close();
  }
}

void main();
