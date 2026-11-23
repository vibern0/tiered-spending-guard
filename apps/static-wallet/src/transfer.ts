import { maxUint256, parseUnits } from "viem";

export const X = 10n * 10n ** 18n;
export const Y = 30n * 10n ** 18n;

export function tokenAmount(text: string) {
  if (text.length > 79 || !/^\d+(\.\d{1,18})?$/.test(text))
    throw Error("Enter a positive GLD amount with at most 18 decimal places.");
  const amount = parseUnits(text, 18);
  if (!amount || amount > maxUint256) throw Error("Invalid GLD amount.");
  return amount;
}

export type Spend = readonly [bigint, bigint, bigint];
export const dayStart = (timestamp: bigint) => timestamp - (timestamp % 86400n);

export function dailyUsage([window, base, combined]: Spend, timestamp: bigint) {
  return window === dayStart(timestamp)
    ? { base, combined }
    : { base: 0n, combined: 0n };
}

export function transferTier(
  amount: bigint,
  { base, combined }: ReturnType<typeof dailyUsage>,
) {
  if (amount + combined > Y) return "delayed";
  return amount + base <= X ? "base" : "step-up";
}
