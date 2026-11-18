import { readFileSync } from "node:fs";
import { repositoryRoot } from "../repository";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { loadCredential, loadFundingKey } from "./secrets";
import { createLiveJournalStore, createSepoliaLiveContext, decodeLiveIntent, verifyBootstrapIntent } from "@tiered-spending-guard/sdk/live/runtime";
import { PHASE_OUTLAY_LIMIT, submitLiveIntent } from "@tiered-spending-guard/sdk/live/submission";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const action = process.argv[2];
if (action !== "plan" && action !== "preflight" && action !== "submit" && action !== "resume" && action !== "evidence") {
  throw new Error("usage: tsx scripts/live/runner.ts <plan|preflight|submit|resume|evidence>");
}

const repository = repositoryRoot();
const fundingKey = loadFundingKey(required("LIVE_FUNDING_KEY_FILE"), repository);
const account = privateKeyToAccount(fundingKey);
const credentials = {
  primary: loadCredential(required("LIVE_PRIMARY_CREDENTIAL_FILE"), repository),
  secondary: loadCredential(required("LIVE_SECONDARY_CREDENTIAL_FILE"), repository),
};
const intent = decodeLiveIntent(readFileSync(required("LIVE_INTENT_FILE"), "utf8"));
verifyBootstrapIntent(intent, account.address, credentials);

const output = (value: Record<string, unknown>): void => console.log(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));

if (action === "plan") {
  output({ action, chainId: sepolia.id, funder: account.address, intent, unsigned: true, broadcast: false });
  process.exit(0);
}

if (action === "submit" && process.env.LIVE_SUBMIT !== "YES") {
  throw new Error("set LIVE_SUBMIT=YES for a broadcast; plan and preflight never broadcast");
}

async function main(): Promise<void> {
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com") });
  const journal = createLiveJournalStore(required("LIVE_JOURNAL_FILE"), account.address);
  try {
    const context = createSepoliaLiveContext({
      account,
      client,
      verify: async () => verifyBootstrapIntent(intent, account.address, credentials),
      persist: async (next) => journal.save(next),
    });
    const current = journal.load();
    if (action === "evidence") {
      output({ action, chainId: sepolia.id, funder: account.address, entries: current.entries, broadcast: false });
      return;
    }
    if (action === "preflight") {
      const [chainId, nonce, balance] = await Promise.all([context.chainId(), context.nonce(), context.balance()]);
      if (chainId !== sepolia.id) throw new Error(`wrong RPC chain: ${chainId}`);
      await context.verify();
      if (nonce !== intent.nonce) throw new Error(`funder nonce drift: expected ${intent.nonce}, observed ${nonce}`);
      const reservation = intent.value + intent.gas * intent.maxFeePerGas;
      const used = current.entries.reduce((sum, entry) => sum + entry.reserved, 0n);
      if (balance < reservation || used + reservation > PHASE_OUTLAY_LIMIT) throw new Error("insufficient balance or phase allowance");
      output({ action, chainId, funder: account.address, nonce, balance, reservation, journalEntries: current.entries.length, broadcast: false });
      return;
    }
    const entry = await submitLiveIntent(intent, current, context);
    output({ action, chainId: sepolia.id, funder: account.address, id: entry.id, transactionHash: entry.transactionHash, status: entry.status, broadcast: action === "submit" });
  } finally {
    journal.close();
  }
}

void main();
