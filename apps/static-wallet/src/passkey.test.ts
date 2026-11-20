import { afterEach, describe, expect, it, vi } from "vitest";
import { signPasskey } from "./passkey";
import { Wallet, type Manifest } from "./wallet";
const sign = vi.hoisted(() => vi.fn());
vi.mock("viem/account-abstraction", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem/account-abstraction")>()),
  toWebAuthnAccount: () => ({ sign }),
}));
const credential = {
  id: "public-id",
  publicKey: `0x${"11".repeat(64)}` as const,
  signer: "0x0000000000000000000000000000000000000002" as const,
};
const hash = `0x${"22".repeat(32)}` as const;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("browser passkey boundary", () => {
  it("propagates user refusal without submitting or persisting a wallet", async () => {
    const persist = vi.fn();
    const wallet = new Wallet(
      {
        chainId: 31337,
        rpcUrl: "http://localhost:8545",
        bundlerUrl: "http://localhost:4337",
      } as Manifest,
      persist,
      () => {},
    );
    vi.spyOn(wallet, "preflight").mockResolvedValue();
    vi.spyOn(wallet, "enroll").mockRejectedValue(
      new DOMException("User cancelled", "NotAllowedError"),
    );
    const rpc = vi.spyOn(wallet, "rpc");
    await expect(wallet.prepare()).rejects.toThrow("User cancelled");
    expect(rpc).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
  it("rejects an assertion from a different origin", async () => {
    vi.stubGlobal("location", {
      hostname: "localhost",
      origin: "http://localhost:5180",
    });
    const challenge = btoa(
      String.fromCharCode(...Array(32).fill(0x22)),
    ).replace(/=+$/, "");
    sign.mockResolvedValue({
      webauthn: {
        clientDataJSON: `{"type":"webauthn.get","challenge":"${challenge}","origin":"https://attacker.invalid"}`,
      },
    });
    await expect(signPasskey(credential, hash)).rejects.toThrow(
      "origin mismatch",
    );
  });
  it("rejects an assertion without user verification", async () => {
    vi.stubGlobal("location", {
      hostname: "localhost",
      origin: "http://localhost:5180",
    });
    const challenge = btoa(
      String.fromCharCode(...Array(32).fill(0x22)),
    ).replace(/=+$/, "");
    sign.mockResolvedValue({
      webauthn: {
        clientDataJSON: `{"type":"webauthn.get","challenge":"${challenge}","origin":"http://localhost:5180"}`,
        authenticatorData: `0x${"00".repeat(32)}0100000000`,
      },
    });
    await expect(signPasskey(credential, hash)).rejects.toThrow(
      "verify the user",
    );
  });
});
