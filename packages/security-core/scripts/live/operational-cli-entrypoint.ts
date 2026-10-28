export type OperationalCliOutput = Readonly<{
  writeStderr(value: string): void;
  setExitCode(value: 1): void;
}>;

export type OperationalCliFailure = "ordinary-scenario-executor" | "ordinary-scenario-repair" | "ordinary-scenario-hashless-continuation";

const FAILURE_DIAGNOSTICS: Readonly<Record<OperationalCliFailure, string>> = Object.freeze({
  "ordinary-scenario-executor": "[ORDINARY_SCENARIO_EXECUTOR_FAILED] ordinary scenario executor failed",
  "ordinary-scenario-repair": "[ORDINARY_SCENARIO_REPAIR_FAILED] ordinary scenario repair failed",
  "ordinary-scenario-hashless-continuation": "[ORDINARY_SCENARIO_HASHLESS_CONTINUATION_FAILED] ordinary scenario hashless continuation failed",
});

const processOutput: OperationalCliOutput = Object.freeze({
  writeStderr: value => { process.stderr.write(value); },
  setExitCode: value => { process.exitCode = value; },
});

/** Emit only a fixed public diagnostic. The rejected value is deliberately never inspected. */
export async function runOperationalCliEntryPoint(task: Promise<void>, failure: OperationalCliFailure, output: OperationalCliOutput = processOutput): Promise<void> {
  try {
    await task;
  } catch {
    output.writeStderr(`${FAILURE_DIAGNOSTICS[failure]}\n`);
    output.setExitCode(1);
  }
}
