import { packagePwaEvidence } from "../../src/pwa/observer";

export function runPwaEvidenceCli(args: readonly string[]): void {
  if (args.length !== 2) throw new Error("usage: pwa:evidence <input-record-directory> <new-output-directory>");
  const manifest = packagePwaEvidence(args[0], args[1]);
  process.stdout.write(`${manifest.manifestHash}\n`);
}

if (require.main === module) {
  try {
    runPwaEvidenceCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "PWA evidence packaging failed"}\n`);
    process.exitCode = 1;
  }
}
