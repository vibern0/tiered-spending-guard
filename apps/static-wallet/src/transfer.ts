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

export function instantTier(
  amount: bigint,
  spend: readonly [bigint, bigint, bigint],
  timestamp: bigint,
) {
  const [window, base, combined] = spend;
  const current = window === timestamp - (timestamp % 86400n);
  if (amount + (current ? combined : 0n) > Y)
    throw Error(
      "This amount needs a delayed withdrawal. The Send button supports instant transfers only.",
    );
  return amount + (current ? base : 0n) <= X ? "base" : "step-up";
}
