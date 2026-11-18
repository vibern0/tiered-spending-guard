import { dirname, join } from "node:path";

const SAFE_SMART_ACCOUNT_ROOT = dirname(require.resolve("@safe-global/safe-smart-account/package.json"));
const SAFE_PASSKEY_ROOT = dirname(require.resolve("@safe-global/safe-passkey/package.json"));

export function safeSmartAccountArtifact(relativePath: string): string {
  return join(SAFE_SMART_ACCOUNT_ROOT, "build/artifacts", relativePath);
}

export function safePasskeyArtifact(relativePath: string): string {
  return join(SAFE_PASSKEY_ROOT, "build/artifacts", relativePath);
}
