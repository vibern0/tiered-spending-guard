import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ResourceManifest = Readonly<{ formatVersion: 1; resources: Readonly<Record<string, string>> }>;

/** Read public build output only when its exact bytes match the generated SDK manifest. Node-only. */
export function readGeneratedResource(name: string): string {
  try {
    if (!/^(?:config|artifacts)\/[A-Za-z0-9_./-]+\.json$/.test(name) || name.split("/").includes("..")) {
      throw new Error("invalid resource name");
    }
    const root = join(__dirname, "../generated");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as ResourceManifest;
    const expected = manifest.resources?.[name];
    if (manifest.formatVersion !== 1 || typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error("resource is not in the build manifest");
    }
    const bytes = readFileSync(join(root, name));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("resource integrity mismatch");
    }
    return bytes.toString("utf8");
  } catch {
    throw new Error("SDK generated resource is missing or inconsistent; run core:build");
  }
}
