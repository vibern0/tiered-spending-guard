// USDC uses 6 decimals. All amounts are bigint base units — never floats.
export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** Parse a user-typed USDC string ("1.234,56", "1234.5", "12") into base units. Returns null if invalid. */
export function parseUsdc(input: string): bigint | null {
  const s = input
    .trim()
    .replace(/\bUSDC\b/gi, "")
    .replace(/[$\s]/g, "");
  if (!s) return null;
  // Treat the last "," or "." as the decimal separator; strip others as grouping.
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  let intPart = s;
  let fracPart = "";
  if (lastSep !== -1 && s.length - lastSep - 1 <= 2) {
    intPart = s.slice(0, lastSep);
    fracPart = s.slice(lastSep + 1);
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) return null;
  if (!intPart && !fracPart) return null;
  const frac = (fracPart + "000000").slice(0, USDC_DECIMALS);
  return BigInt(intPart || "0") * UNIT + BigInt(frac);
}

/** Format base units as a locale-aware USDC string, e.g. 8,600.00 USDC. */
export function formatUsdc(units: bigint, locale = "en-IE"): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const cents = (abs + UNIT / 200n) / (UNIT / 100n); // round half up to cents
  const whole = cents / 100n;
  const rem = cents % 100n;
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(1000.5);
  const group = parts.find((p) => p.type === "group")?.value ?? ",";
  const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${neg ? "−" : ""}${wholeStr}${decimal}${rem.toString().padStart(2, "0")} USDC`;
}

export const usdc = (whole: number) => BigInt(whole) * UNIT;
