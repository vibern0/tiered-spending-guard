/**
 * Importing a caller-selected TypeScript module here would execute it with the
 * observer process's full authority. A JavaScript interface cannot prove that
 * such a module is read-only, so the executable entrypoint stays fail-closed
 * until a fixed in-repository RPC/topology composition is reviewed.
 */
export async function runPwaObserverCli(_args: readonly string[]): Promise<void> {
  throw new Error("pwa:observe is disabled until the fixed in-repository read-only RPC/topology composition is reviewed");
}

if (require.main === module) {
  runPwaObserverCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("PWA observation is unavailable: fixed reviewed observer composition required\n");
    process.exitCode = 1;
  });
}
