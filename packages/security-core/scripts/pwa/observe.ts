import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Hex } from "viem";
import {
  observePwaReceipt,
  serializePwaObserverRecord,
  type PwaObserverBinding,
} from "../../src/pwa/observer";

const HASH = /^0x[0-9a-fA-F]{64}$/;

function regularFile(path: string, label: string): string {
  if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} must be an absolute regular non-symlink file`);
  }
  return realpathSync(path);
}

export async function runPwaObserverCli(args: readonly string[]): Promise<void> {
  if (args.length !== 3) throw new Error("usage: pwa:observe <absolute-read-only-adapter.ts> <receipt-hash> <absolute-output.json>");
  const [adapterInput, receiptHash, outputInput] = args;
  if (!HASH.test(receiptHash)) throw new Error("receipt hash must be bytes32 hex");
  const adapterPath = regularFile(adapterInput, "observer adapter");
  if (!isAbsolute(outputInput) || existsSync(outputInput)) throw new Error("observer output must be a new absolute path");

  const loaded = await import(pathToFileURL(adapterPath).href) as Record<string, unknown>;
  if (Object.keys(loaded).length !== 1 || !("createObserverBinding" in loaded) || typeof loaded.createObserverBinding !== "function") {
    throw new Error("observer adapter must export only createObserverBinding");
  }
  const executableHash = `0x${createHash("sha256").update(readFileSync(adapterPath)).digest("hex")}` as Hex;
  const binding = await (loaded.createObserverBinding as (identity: Readonly<{ executableHash: Hex }>) => Promise<PwaObserverBinding>)({ executableHash });
  const record = await observePwaReceipt(binding, receiptHash as Hex);
  if (record.observer.executableHash.toLowerCase() !== executableHash.toLowerCase()) throw new Error("observer adapter identity does not bind its executable hash");
  writeFileSync(resolve(outputInput), serializePwaObserverRecord(record), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

if (require.main === module) {
  runPwaObserverCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "PWA observation failed"}\n`);
    process.exitCode = 1;
  });
}
