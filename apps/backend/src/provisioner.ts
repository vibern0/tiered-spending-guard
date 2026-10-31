import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAddress, type Address, type Hex } from "viem";
import { assertConfiguredAddress } from "./config";
import { SEPOLIA_USDC_ADDRESS, type FreshVaultProvisioner, type ReviewedDeploymentEvidence } from "./vault";
import type { BackendPreparation, BackendSubmission, BackendSubmissionReader } from "./handlers";

function outsideRepository(path: string): void {
  if (!path.startsWith("/")) throw new Error("reviewed backend path must be absolute");
  const repository = `${process.cwd().replace(/\/packages\/security-core$/, "")}/`;
  if (path === repository.slice(0, -1) || path.startsWith(repository)) throw new Error("reviewed backend path must be outside the repository");
}

function hash(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${label} must be a bytes32 hash`);
  return value as Hex;
}

export function loadReviewedDeploymentEvidence(path: string): ReviewedDeploymentEvidence {
  outsideRepository(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("reviewed deployment evidence could not be loaded safely");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("reviewed deployment evidence is malformed");
  const value = parsed as Record<string, unknown>;
  if (value.verified !== true || value.chainId !== 11155111) throw new Error("reviewed Sepolia deployment evidence is required");
  return Object.freeze({
    verified: true,
    chainId: 11155111,
    safeSingleton: assertConfiguredAddress(String(value.safeSingleton), "safeSingleton"),
    safeProxyFactory: assertConfiguredAddress(String(value.safeProxyFactory), "safeProxyFactory"),
    passkeySignerFactory: assertConfiguredAddress(String(value.passkeySignerFactory), "passkeySignerFactory"),
    delayArtifactHash: hash(value.delayArtifactHash, "delayArtifactHash"),
  });
}

export type ReviewedBackendModule = Readonly<{
  usdc: Address;
  provisioner: FreshVaultProvisioner;
  prepareTransfer: BackendPreparation;
  submit: BackendSubmission;
  submission: BackendSubmissionReader;
}>;

export async function loadReviewedBackendModule(path: string): Promise<ReviewedBackendModule> {
  outsideRepository(path);
  const imported = await import(pathToFileURL(path).href) as {
    createBackendModule?: () => ReviewedBackendModule | Promise<ReviewedBackendModule>;
    usdc?: Address;
    createProvisioner?: () => FreshVaultProvisioner;
    provisioner?: FreshVaultProvisioner;
    prepareTransfer?: BackendPreparation;
    submit?: BackendSubmission;
    submission?: BackendSubmissionReader;
  };
  const module = imported.createBackendModule ? await imported.createBackendModule() : {
    usdc: imported.usdc,
    provisioner: imported.createProvisioner?.() ?? imported.provisioner,
    prepareTransfer: imported.prepareTransfer,
    submit: imported.submit,
    submission: imported.submission,
  };
  if (!module.usdc || !isAddress(module.usdc) || module.usdc.toLowerCase() !== SEPOLIA_USDC_ADDRESS.toLowerCase() || !module.provisioner || typeof module.provisioner.deploy !== "function" || typeof module.prepareTransfer !== "function" || typeof module.submit !== "function" || typeof module.submission !== "function") throw new Error("reviewed backend module must provide pinned Sepolia USDC, provisioner, prepareTransfer, submit, and submission");
  return module as ReviewedBackendModule;
}

export function assertProvisionerAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return value;
}
