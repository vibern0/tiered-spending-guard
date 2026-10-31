import { isAddress, type Address } from "viem";

export type BackendConfig = Readonly<{
  id: "local" | "https";
  host: "127.0.0.1";
  port: number;
  chainId: 11155111;
  rpId: string;
  origin: string;
  rpcUrl: string;
  relayPrivateKey: `0x${string}`;
  journalPath: string;
  reviewedArtifactsPath: string;
  provisionerModulePath: string;
}>;

export type BackendEnvironment = Readonly<Record<string, string | undefined>>;

function exactOrigin(input: string, label: string): URL {
  if (input.includes("*")) throw new Error(`${label} cannot contain a wildcard`);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`${label} is not a valid origin`); }
  if (url.origin !== input || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error(`${label} must be an exact origin`);
  return url;
}

function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isPreviewHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().split(".");
  return labels.some((label) => label === "preview" || label.startsWith("preview-") || label.startsWith("deploy-preview-") || /^pr-\d+$/.test(label));
}

export function assertBackendWebAuthnIdentity(id: "local" | "https", origin: string, rpId: string): void {
  if (!rpId || rpId.includes("*") || rpId.includes(":") || rpId.includes("/") || isIpHost(rpId)) throw new Error("BACKEND_RP_ID must be an exact DNS hostname");
  const parsed = exactOrigin(origin, "BACKEND_ORIGIN");
  if (id === "local") {
    if (parsed.origin !== "http://localhost:5173" || rpId !== "localhost") throw new Error("local BACKEND_ORIGIN and BACKEND_RP_ID must use the fixed localhost profile");
    return;
  }
  if (parsed.protocol !== "https:") throw new Error("HTTPS backend profile requires an HTTPS BACKEND_ORIGIN");
  if (parsed.hostname !== rpId) throw new Error("BACKEND_ORIGIN hostname must equal BACKEND_RP_ID");
  if (parsed.hostname === "localhost" || isIpHost(parsed.hostname)) throw new Error("BACKEND_RP_ID must be a DNS hostname");
  if (isPreviewHost(parsed.hostname)) throw new Error("preview hosts are not accepted backend profiles");
}

export function loadBackendConfig(env: BackendEnvironment = process.env): BackendConfig {
  const id = env["BACKEND_PROFILE"];
  if (id !== "local" && id !== "https") throw new Error("BACKEND_PROFILE must be local or https");
  const relayPrivateKey = env["BACKEND_RELAY_PRIVATE_KEY"];
  if (!relayPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(relayPrivateKey)) throw new Error("BACKEND_RELAY_PRIVATE_KEY is required and must be a local secret");
  const rpcUrl = env["BACKEND_RPC_URL"];
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) throw new Error("BACKEND_RPC_URL is required");
  const port = Number(env["BACKEND_PORT"] ?? "8787");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("BACKEND_PORT is invalid");
  const origin = env["BACKEND_ORIGIN"] ?? (id === "local" ? "http://localhost:5173" : undefined);
  const rpId = env["BACKEND_RP_ID"] ?? (id === "local" ? "localhost" : undefined);
  if (!origin) throw new Error("BACKEND_ORIGIN is required for the HTTPS profile");
  if (!rpId) throw new Error("BACKEND_RP_ID is required for the HTTPS profile");
  assertBackendWebAuthnIdentity(id, origin, rpId);
  const journalPath = env["BACKEND_JOURNAL_PATH"];
  if (!journalPath || !journalPath.startsWith("/")) throw new Error("BACKEND_JOURNAL_PATH must point outside the repository");
  const reviewedArtifactsPath = env["BACKEND_REVIEWED_ARTIFACTS"];
  if (!reviewedArtifactsPath || !reviewedArtifactsPath.startsWith("/")) throw new Error("BACKEND_REVIEWED_ARTIFACTS must point to reviewed artifacts outside the repository");
  const provisionerModulePath = env["BACKEND_PROVISIONER_MODULE"];
  if (!provisionerModulePath || !provisionerModulePath.startsWith("/")) throw new Error("BACKEND_PROVISIONER_MODULE must point to a reviewed adapter outside the repository");
  return Object.freeze({ id, host: "127.0.0.1", port, chainId: 11155111, rpId, origin, rpcUrl, relayPrivateKey: relayPrivateKey as `0x${string}`, journalPath, reviewedArtifactsPath, provisionerModulePath });
}

export function assertConfiguredAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not an address`);
  return value;
}

export function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
