import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { validateSlitherExit, validateSlitherReport, type SlitherReport } from "./security/slither-gate";

const dir = mkdtempSync(join(tmpdir(), "recent-tx-slither-"));
const output = join(dir, "slither.json");
try {
  const result = spawnSync("python3", ["-m", "slither", ".", "--config-file", "slither.config.json", "--json", output], { stdio: "inherit" });
  const report = JSON.parse(readFileSync(output, "utf8")) as SlitherReport;
  const baseline = JSON.parse(readFileSync("slither-baseline.json", "utf8")) as { findings?: unknown };
  if (!Array.isArray(baseline.findings) || baseline.findings.some((finding) => typeof finding !== "string")) throw new Error("malformed Slither baseline");
  const current = validateSlitherReport(report, baseline.findings);
  validateSlitherExit(result.status, result.error, true);
  console.log(`Slither gate passed: ${current.length} reviewed baseline findings; no new findings.`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
