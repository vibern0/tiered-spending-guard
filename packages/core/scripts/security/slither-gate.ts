export type SlitherFinding = { check?: unknown; first_markdown_element?: unknown; elements?: unknown };
export type SlitherReport = { success?: unknown; error?: unknown; results?: { detectors?: unknown } };

export function validateSlitherExit(status: number | null, error?: Error | null, validReport = false): void {
  if (error) throw error;
  if (status !== 0 && !(status === 255 && validReport)) throw new Error(`Slither failed with exit ${String(status)}`);
}

function findingKey(finding: SlitherFinding): string {
  if (typeof finding.check !== "string" || typeof finding.first_markdown_element !== "string" || !Array.isArray(finding.elements)) throw new Error("malformed Slither detector");
  const elements = finding.elements as Array<Record<string, unknown>>;
  if (elements.some((element) => !element || typeof element !== "object" || typeof element.type !== "string")) throw new Error("malformed Slither detector element");
  const functionElement = elements.find((element) => element.type === "function");
  const nodeElement = elements.find((element) => element.type === "node");
  const parent = nodeElement && typeof nodeElement.type_specific_fields === "object" && nodeElement.type_specific_fields !== null
    ? (nodeElement.type_specific_fields as { parent?: { name?: unknown } }).parent : undefined;
  const functionName = typeof functionElement?.name === "string" ? functionElement.name : typeof parent?.name === "string" ? parent.name : "<node>";
  return `${finding.check}|${functionName}|${finding.first_markdown_element}`;
}

export function validateSlitherReport(report: SlitherReport, baseline: readonly string[]): string[] {
  if (report.success !== true) throw new Error("Slither report did not succeed");
  if (report.error !== null && report.error !== undefined) throw new Error(`Slither report contains an error: ${String(report.error)}`);
  if (!report.results || !Array.isArray(report.results.detectors)) throw new Error("Slither report has no detectors array");
  const current = new Set(report.results.detectors.map((finding) => findingKey(finding as SlitherFinding)));
  const allowed = new Set(baseline);
  const unexpected = [...current].filter((finding) => !allowed.has(finding));
  if (unexpected.length) throw new Error(`new Slither findings:\n${unexpected.join("\n")}`);
  return [...current];
}
