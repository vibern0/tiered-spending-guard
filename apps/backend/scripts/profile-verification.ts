import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Session } from "node:inspector/promises";
import { isAddress, type Address } from "viem";
import * as namespace from "@recent-tx-safe-guard/security-core/pwa";
import { assertExternalBackendPath } from "../src/config";
import { createSubmissionReadClient } from "../src/submission-runtime";
import { loadManagedPwaSuccessors, mergePwaSuccessors } from "../src/managed-successors";
import { VerificationProfiler } from "./verification-profiler";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
export type ProfileOptions = Readonly<{ accountDirectory: string; outputDirectory?: string; samples: number }>;
const forbidden = async (): Promise<never> => { throw new Error("read-only profiling forbids this operation"); };

function checkedOptions(options: ProfileOptions): ProfileOptions {
  const accountDirectory = assertExternalBackendPath(options.accountDirectory, "profiling account directory");
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 5) throw new Error("profiling samples must be an integer from 1 to 5");
  const outputDirectory = options.outputDirectory === undefined ? undefined : assertExternalBackendPath(options.outputDirectory, "profiling output directory");
  if (outputDirectory) {
    const fromAccount = relative(accountDirectory, outputDirectory);
    if (fromAccount === "" || (fromAccount !== ".." && !fromAccount.startsWith(`..${sep}`) && !isAbsolute(fromAccount))) throw new Error("profiling output directory must be outside source evidence");
    if (existsSync(outputDirectory)) throw new Error("profiling output directory already exists");
  }
  return { accountDirectory, ...(outputDirectory ? { outputDirectory } : {}), samples: options.samples };
}

export function parseProfileArguments(args: readonly string[]): ProfileOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!["--account-directory", "--output-directory", "--samples"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("unsupported or ambiguous profiling arguments");
    values.set(key, value);
  }
  const samples = values.get("--samples") ?? "3";
  if (!/^[1-5]$/.test(samples)) throw new Error("profiling samples must be an integer from 1 to 5");
  return checkedOptions({ accountDirectory: values.get("--account-directory") ?? "", outputDirectory: values.get("--output-directory"), samples: Number(samples) });
}

/** Isolated diagnostic: no environment secrets, signer, deployment authorizer or source journal writer. */
export async function profileVerification(input: ProfileOptions) {
  const options = checkedOptions(input);
  const journalPath = join(options.accountDirectory, "provisioning.json");
  const raw = JSON.parse(readFileSync(journalPath, "utf8")) as { funder?: unknown };
  if (typeof raw.funder !== "string" || !isAddress(raw.funder)) throw new Error("profiling requires public provisioning identity");
  const deployer = raw.funder as Address;
  const journal = core.readLiveJournal(journalPath, deployer);
  if (journal.entries.length !== 7 || journal.entries.some(entry => entry.status !== "success" || !entry.receipt)) throw new Error("profiling requires seven successful deployment receipts");
  const outputDirectory = checkedOptions({ ...options, outputDirectory: options.outputDirectory ?? join(tmpdir(), `vault-verification-profile-${randomUUID()}`) }).outputDirectory!;
  mkdirSync(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  mkdirSync(outputDirectory, { mode: 0o700 });
  const profiler = new VerificationProfiler();
  const abort = new AbortController();
  const measuredFetch = profiler.wrapFetch(fetch, core.PWA_IDENTITY_PROVIDERS);
  const profileFetch: typeof fetch = (url, init) => measuredFetch(url, { ...init,
    signal: AbortSignal.any([abort.signal, ...(init?.signal ? [init.signal] : [])]),
  });
  const cpu = new Session();
  let connected = false, started = false, completed = false;
  let failureCode: string | undefined;
  try {
    cpu.connect(); connected = true;
    await cpu.post("Profiler.enable");
    await cpu.post("Profiler.start"); started = true;
    const providers = [createSubmissionReadClient(core.PWA_IDENTITY_PROVIDERS[0], "profile provider 1", { fetchFn: profileFetch }), createSubmissionReadClient(core.PWA_IDENTITY_PROVIDERS[1], "profile provider 2", { fetchFn: profileFetch })] as const;
    // The first fixed public provider supplies nonce observations too. No private
    // relay URL/key or live backend account/session is loaded by this command.
    const relay = providers[0];
    const recovery = await profiler.phase("recovery", () => core.resolvePwaProvisioningRecovery({
      reviewDirectory: join(options.accountDirectory, "reviews"), journal,
      profile: core.loadCommittedPwaPhaseOneProfile(), safeProxySaltNonce: core.loadCommittedPwaProvisioningAutomationPolicy().safeProxySaltNonce,
      providers, relay,
      successors: mergePwaSuccessors(core.loadCommittedPwaProvisioningSuccessors(), loadManagedPwaSuccessors(journalPath, deployer)),
    }));
    if (!recovery || recovery.confirmedPrefixLength !== 7 || recovery.plan.transactions.length !== 7) throw new Error("profiling requires verified completed recovery");
    const context = core.createDurablePwaProvisioningExecutionContext({
      plan: recovery.plan, journal, client: relay,
      liveContext: { funder: deployer, nonce: () => relay.getTransactionCount({ address: deployer, blockTag: "latest" }),
        chainId: relay.getChainId, balance: forbidden, verify: forbidden, sign: forbidden, broadcast: forbidden, receipt: forbidden, persist: forbidden },
    });
    const vault = await profiler.phase("restore", () => core.executePwaProvisioning(recovery.plan, context));
    for (let sample = 1; sample <= options.samples; sample++) {
      await profiler.phase("verification", async () => {
        const heads = await Promise.all(providers.map(client => client.getBlockNumber()));
        if (heads[0] > heads[1] + 2n || heads[1] > heads[0] + 2n) throw new Error("profiling providers disagree on height");
        const blockNumber = heads[0] < heads[1] ? heads[0] : heads[1];
        const results = await Promise.allSettled(providers.map(client => core.verifyPwaSubmissionState({ plan: recovery.plan, vault, client, blockNumber })));
        const failure = results.find(result => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const proofs = results.map(result => { if (result.status === "rejected") throw result.reason; return result.value; });
        const identity = (proof: typeof proofs[number]) => core.canonicalSubmissionJson({ policyHash: proof.vault.policyHash, topologyReportHash: proof.topologyReportHash });
        if (identity(proofs[0]) !== identity(proofs[1])) throw new Error("profiling providers disagree on verification");
      }, sample);
    }
    completed = true;
  } catch (error) {
    failureCode = error instanceof Error && error.message.includes("an evidence provider is missing confirmed prefix evidence")
      ? "missing-confirmed-deployment-evidence"
      : error instanceof Error && error.message.includes("Sepolia RPC request failed")
        ? "rpc-unavailable" : "verification-failed";
  } finally {
    abort.abort();
    try {
      if (started) {
        const { profile } = await cpu.post("Profiler.stop");
        writeFileSync(join(outputDirectory, "verification.cpuprofile"), JSON.stringify(profile), { flag: "wx", mode: 0o600 });
      }
    } finally {
      if (connected) cpu.disconnect();
      const report = profiler.report();
      writeFileSync(join(outputDirectory, "verification.trace.json"), JSON.stringify({ traceEvents: report.traceEvents, displayTimeUnit: "ms" }), { flag: "wx", mode: 0o600 });
      writeFileSync(join(outputDirectory, "summary.json"), JSON.stringify({ scope: "read-only-verification-core", completed, ...(failureCode ? { failureCode } : {}), excludes: ["browser rendering", "passkey interaction", "backend snapshot collection", "submission simulation", "broadcast", "block inclusion", "confirmation wait"], ...report.summary }, null, 2), { flag: "wx", mode: 0o600 });
    }
  }
  if (!completed) throw Object.assign(new Error("read-only verification profiling failed closed"), { outputDirectory });
  return { outputDirectory, ...profiler.report().summary };
}

const HELP = "Usage: npm run backend:profile:verification -- --account-directory /absolute/external/account [--output-directory /new/external/directory] [--samples 1..5]\nRead-only verification-core profile. No credentials, signing or broadcast. Outputs summary.json, verification.trace.json and verification.cpuprofile outside the repository.";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).includes("--help")) console.log(HELP);
  else void (async () => {
    const report = await profileVerification(parseProfileArguments(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  })().catch((error: unknown) => { process.exitCode = 1;
    if (error && typeof error === "object" && "outputDirectory" in error) console.error(JSON.stringify({ outputDirectory: error.outputDirectory, completed: false }));
    console.error("Read-only verification profiling failed closed. Check the command arguments, completed deployment evidence and local diagnostic output; no transaction was signed or broadcast."); });
}
