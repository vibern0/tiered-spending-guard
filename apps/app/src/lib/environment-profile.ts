export type WalletEnvironmentProfile = Readonly<{
  id: "local" | "https";
  chainId: 11155111;
  appOrigin: string;
  rpId: string;
  backendOrigin: string;
  credentials: "omit" | "include";
}>;

export type WalletEnvironment = Readonly<Record<string, string | boolean | undefined>>;

const LOCAL_APP_ORIGIN = "http://localhost:5173";
const LOCAL_BACKEND_ORIGIN = "http://127.0.0.1:8787";

function value(env: WalletEnvironment, key: string): string | undefined {
  const candidate = env[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function exactOrigin(input: string, label: string): URL {
  if (input.includes("*")) throw new Error(`${label} cannot contain a wildcard`);
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`${label} is not a valid origin`); }
  if (url.origin !== input || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must be an exact origin without credentials, path, query, or fragment`);
  }
  return url;
}

function isIpHost(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function isPreviewHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().split(".");
  return labels.some((label) => label === "preview" || label.startsWith("preview-") || label.startsWith("deploy-preview-") || /^pr-\d+$/.test(label));
}

export function loadWalletEnvironmentProfile(env: WalletEnvironment, observedOrigin: string): WalletEnvironmentProfile {
  const id = value(env, "VITE_WALLET_PROFILE") ?? "local";
  if (id !== "local" && id !== "https") throw new Error("VITE_WALLET_PROFILE must be local or https");

  const appOrigin = value(env, "VITE_APP_ORIGIN") ?? (id === "local" ? LOCAL_APP_ORIGIN : undefined);
  const rpId = value(env, "VITE_WEBAUTHN_RP_ID") ?? (id === "local" ? "localhost" : undefined);
  const backendOrigin = value(env, "VITE_BACKEND_ORIGIN") ?? (id === "local" ? LOCAL_BACKEND_ORIGIN : undefined);
  if (!appOrigin) throw new Error("VITE_APP_ORIGIN is required for the HTTPS profile");
  if (!rpId) throw new Error("VITE_WEBAUTHN_RP_ID is required for the HTTPS profile");
  if (!backendOrigin) throw new Error("VITE_BACKEND_ORIGIN is required for the HTTPS profile");
  if (rpId.includes("*") || rpId.includes(":") || rpId.includes("/") || isIpHost(rpId)) throw new Error("VITE_WEBAUTHN_RP_ID must be an exact DNS hostname");

  const app = exactOrigin(appOrigin, "VITE_APP_ORIGIN");
  const backend = exactOrigin(backendOrigin, "VITE_BACKEND_ORIGIN");
  const observed = exactOrigin(observedOrigin, "observed app origin");
  if (observed.origin !== app.origin) throw new Error("observed app origin does not match the configured wallet profile");

  if (id === "local") {
    if (app.origin !== LOCAL_APP_ORIGIN || rpId !== "localhost" || backend.origin !== LOCAL_BACKEND_ORIGIN) {
      throw new Error("local wallet profile must use the fixed localhost app, RP ID, and loopback backend origins");
    }
    return Object.freeze({ id, chainId: 11155111, appOrigin: app.origin, rpId, backendOrigin: backend.origin, credentials: "omit" });
  }

  if (app.protocol !== "https:" || backend.protocol !== "https:") throw new Error("HTTPS wallet profile requires HTTPS app and backend origins");
  if (app.hostname !== rpId) throw new Error("HTTPS app origin hostname must equal the WebAuthn RP ID");
  if (app.hostname === "localhost" || backend.hostname === "localhost" || isIpHost(app.hostname) || isIpHost(backend.hostname)) throw new Error("HTTPS wallet profile requires DNS hostnames");
  if (isPreviewHost(app.hostname) || isPreviewHost(backend.hostname)) throw new Error("preview hosts are not accepted wallet profiles");

  return Object.freeze({ id, chainId: 11155111, appOrigin: app.origin, rpId, backendOrigin: backend.origin, credentials: "include" });
}
