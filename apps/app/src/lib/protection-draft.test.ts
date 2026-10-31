import { describe, expect, it } from "vitest";
import { validateProtectionDraft } from "./protection-draft";

const valid = {
  firstSignerDaily: "250",
  instantDaily: "1000",
  basePerTxCap: "100",
  perTxCap: "200",
  delaySeconds: "120",
  recipients: "0x1111111111111111111111111111111111111111",
  firstSigner: "",
  secondSigner: "",
  frozen: false,
};

describe("protection drafts", () => {
  it("preserves all six USDC decimals and exact delay seconds", () => {
    expect(validateProtectionDraft({ ...valid, firstSignerDaily: "250.000001" })).toMatchObject({
      firstSignerDaily: 250000001n,
      delaySeconds: 120n,
    });
  });
  it.each([
    { firstSignerDaily: "0" },
    { firstSignerDaily: "1000" },
    { firstSignerDaily: "1.0000001" },
    { basePerTxCap: "251" },
    { perTxCap: "1001" },
    { delaySeconds: "0" },
    { delaySeconds: "1.5" },
    { recipients: "0x0000000000000000000000000000000000000000" },
    { recipients: "not an address" },
    { recipients: `${valid.recipients}\n${valid.recipients}` },
    { firstSigner: "bad signer" },
    { firstSigner: valid.recipients, secondSigner: valid.recipients },
  ])("rejects invalid policy input %j", (invalid) => {
    expect(() => validateProtectionDraft({ ...valid, ...invalid })).toThrow();
  });
});
