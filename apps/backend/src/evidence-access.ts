import { readFileSync, statSync } from "node:fs";
import * as namespace from "@recent-tx-safe-guard/security-core/pwa";
import { assertExternalBackendPath } from "./config";

const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
export type EvidenceAccess = Readonly<{
  profile: "publicnode-tenderly" | "infura-archive";
  urls: readonly [string, string];
  operators: readonly ["publicnode" | "infura", "tenderly"];
}>;

/** Current read access only. Never modifies historical signed PWA profile commitments. */
export function loadEvidenceAccess(configPath?: string): EvidenceAccess {
  if (configPath === undefined) return Object.freeze({ profile: "publicnode-tenderly", urls: core.PWA_IDENTITY_PROVIDERS, operators: Object.freeze(["publicnode", "tenderly"] as const) });
  try {
    const path = assertExternalBackendPath(configPath, "evidence access configuration");
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 16_384 || (stat.mode & 0o077) !== 0) throw new Error();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join() !== "profile,rpcUrl,version" || record.version !== 1 || record.profile !== "infura-archive" || typeof record.rpcUrl !== "string") throw new Error();
    const url = new URL(record.rpcUrl);
    if (url.href !== record.rpcUrl || url.protocol !== "https:" || url.hostname !== "sepolia.infura.io" || url.port || url.username || url.password || url.search || url.hash || !/^\/v3\/[a-fA-F0-9]{32}$/.test(url.pathname)) throw new Error();
    return Object.freeze({ profile: "infura-archive", urls: Object.freeze([url.href, core.PWA_IDENTITY_PROVIDERS[1]] as const), operators: Object.freeze(["infura", "tenderly"] as const) });
  } catch {
    // Configuration may contain an RPC credential. Never echo its contents/path.
    throw new Error("evidence access configuration failed closed");
  }
}
