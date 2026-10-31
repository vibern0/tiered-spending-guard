import { getAddress, isAddress, zeroAddress, type Address } from "viem";

/** Unsigned UI proposal. Never an authorization or an active onchain policy. */
export type ProtectionDraft = {
  firstSignerDaily: string;
  instantDaily: string;
  basePerTxCap: string;
  perTxCap: string;
  delaySeconds: string;
  recipients: string;
  firstSigner: string;
  secondSigner: string;
  frozen: boolean;
};

function amount(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim()))
    throw new Error(
      "Enter USDC amounts with up to six decimal places, without grouping separators.",
    );
  const [whole = "0", fraction = ""] = value.trim().split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function address(value: string): Address {
  if (!isAddress(value) || value.toLowerCase() === zeroAddress)
    throw new Error("Use a valid, non-zero address for each recipient or replacement signer.");
  return getAddress(value);
}

export function editableAmount(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function validateProtectionDraft(draft: ProtectionDraft) {
  const firstSignerDaily = amount(draft.firstSignerDaily),
    instantDaily = amount(draft.instantDaily);
  const basePerTxCap = amount(draft.basePerTxCap),
    perTxCap = amount(draft.perTxCap);
  if (!(firstSignerDaily > 0n && firstSignerDaily < instantDaily))
    throw new Error(
      "First-signer daily limit must be above zero and below the instant daily limit.",
    );
  if (
    basePerTxCap <= 0n ||
    basePerTxCap > firstSignerDaily ||
    perTxCap <= 0n ||
    perTxCap > instantDaily
  )
    throw new Error(
      "Each per-transfer maximum must be above zero and no greater than its daily limit.",
    );
  if (
    !/^\d+$/.test(draft.delaySeconds) ||
    BigInt(draft.delaySeconds) <= 0n ||
    BigInt(draft.delaySeconds) > 18_446_744_073_709_551_615n
  )
    throw new Error(
      "Enter a positive whole number of waiting-period seconds within uint64 bounds.",
    );
  const recipients = draft.recipients
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(address);
  if (!recipients.length) throw new Error("Keep at least one allowed recipient.");
  if (new Set(recipients.map((entry) => entry.toLowerCase())).size !== recipients.length)
    throw new Error("Each recipient must appear only once.");
  const firstSigner = draft.firstSigner.trim() ? address(draft.firstSigner.trim()) : undefined;
  const secondSigner = draft.secondSigner.trim() ? address(draft.secondSigner.trim()) : undefined;
  if (firstSigner && secondSigner && firstSigner === secondSigner)
    throw new Error("First and second signers must be different.");
  return {
    firstSignerDaily,
    instantDaily,
    basePerTxCap,
    perTxCap,
    delaySeconds: BigInt(draft.delaySeconds),
    recipients,
    firstSigner,
    secondSigner,
    frozen: draft.frozen,
  };
}
