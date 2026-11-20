import { isAddress, type Address, type Hex } from "viem";
export const X = 10n ** 15n,
  Y = 3n * X;
export type Manifest = {
  chainId: number;
  rpcUrl: string;
  bundlerUrl: string;
  hashes: Record<string, Hex>;
} & Record<
  | "entryPoint"
  | "singleton"
  | "proxyFactory"
  | "standardModule"
  | "moduleSetup"
  | "multiSend"
  | "multiSendCallOnly"
  | "signerFactory"
  | "verifier"
  | "createCall"
  | "paymaster"
  | "recipient",
  Address
>;
export type Credential = { id: string; publicKey: Hex; signer: Address };
export type WalletRecord = {
  version: 1;
  chainId: 31337;
  safe: Address;
  primary: Credential;
  salt: Hex;
  initializer: Hex;
  secondary?: Credential;
  pending?: { hash: Hex; label: string };
};
export type WalletState = "undeployed" | "ordinary" | "enabled" | "blocked";
export const KEY = "static-vault.local.v1";
export const same = (a: unknown, b: unknown) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();
export function assertLocal(
  m: Pick<Manifest, "chainId" | "rpcUrl" | "bundlerUrl">,
) {
  if (m.chainId !== 31337)
    throw Error("Only the disposable local chain 31337 is supported.");
  for (const endpoint of [m.rpcUrl, m.bundlerUrl]) {
    const u = new URL(endpoint);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.protocol !== "http:" ||
      u.username ||
      u.password
    )
      throw Error("Only local, credential-free RPC endpoints are supported.");
  }
}
export function parseRecord(raw: string | null): WalletRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (
      r.version !== 1 ||
      r.chainId !== 31337 ||
      !isAddress(r.safe) ||
      !isAddress(r.primary?.signer) ||
      typeof r.primary?.id !== "string" ||
      !/^0x[0-9a-f]{128}$/i.test(r.primary?.publicKey) ||
      !/^0x[0-9a-f]{64}$/i.test(r.salt) ||
      !/^0x(?:[0-9a-f]{2})+$/i.test(r.initializer) ||
      (r.secondary &&
        (!isAddress(r.secondary.signer) ||
          typeof r.secondary.id !== "string" ||
          !/^0x[0-9a-f]{128}$/i.test(r.secondary.publicKey))) ||
      (r.pending &&
        (!/^0x[0-9a-f]{64}$/i.test(r.pending.hash) ||
          typeof r.pending.label !== "string"))
    )
      return null;
    return r;
  } catch {
    return null;
  }
}
export function classifyState(
  deployed: boolean,
  ordinary: boolean,
  enabled: boolean,
): WalletState {
  return !deployed
    ? "undeployed"
    : enabled
      ? "enabled"
      : ordinary
        ? "ordinary"
        : "blocked";
}
export function policyMatches(
  p: readonly unknown[],
  s: readonly unknown[],
  secondary: Address | string,
) {
  return (
    p.length === 5 &&
    p[0] === X &&
    p[1] === Y &&
    p[2] === X &&
    p[3] === Y &&
    Number(p[4]) === 0 &&
    same(s[0], secondary) &&
    Number(s[1]) === 0 &&
    s[2] === true
  );
}
