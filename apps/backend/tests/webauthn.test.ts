import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { verifyPasskeyAssertion, verifyPasskeyRegistration } from "../src/webauthn";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CHALLENGE = Buffer.from(HASH.slice(2), "hex").toString("base64url");

const registration = {
  role: "primary" as const,
  credentialId: "primary-credential",
  challenge: CHALLENGE,
  rpId: "localhost",
  origin: "http://localhost:5173",
  response: {
    id: "primary-credential",
    rawId: "cHJpbWFyeS1jcmVkZW50aWFs",
    type: "public-key",
    response: { clientDataJSON: "", attestationObject: "" },
    clientExtensionResults: {},
  },
};

describe("backend WebAuthn binding", () => {
  it("accepts distinct primary and secondary registrations only when the bridge ceremony matches", async () => {
    const primary = await verifyPasskeyRegistration({ ...registration, role: "primary" }, async () => ({ verified: true, credentialId: "primary-credential", publicKey: "primary-key", counter: 0 }));
    const secondary = await verifyPasskeyRegistration({ ...registration, role: "secondary", credentialId: "secondary-credential", response: { ...registration.response, id: "secondary-credential" } }, async () => ({ verified: true, credentialId: "secondary-credential", publicKey: "secondary-key", counter: 0 }));

    expect(primary.credentialId).not.toBe(secondary.credentialId);
    await expect(verifyPasskeyRegistration({ ...registration, origin: "https://evil.invalid" }, async () => ({ verified: true, credentialId: "primary-credential", publicKey: "primary-key", counter: 0 }))).rejects.toThrow();
  });

  it("accepts an exact HTTPS RP and rejects mixed or unsafe WebAuthn identity", async () => {
    const https = { ...registration, rpId: "vault.example", origin: "https://vault.example" };
    await expect(verifyPasskeyRegistration(https, async () => ({ verified: true, credentialId: "primary-credential", publicKey: "primary-key", counter: 0 }))).resolves.toMatchObject({ credentialId: "primary-credential" });
    await expect(verifyPasskeyRegistration({ ...https, origin: "https://preview.example" }, async () => ({ verified: true, credentialId: "primary-credential", publicKey: "primary-key", counter: 0 }))).rejects.toThrow();
    await expect(verifyPasskeyRegistration({ ...https, origin: "http://vault.example" }, async () => ({ verified: true, credentialId: "primary-credential", publicKey: "primary-key", counter: 0 }))).rejects.toThrow();
    await expect(verifyPasskeyRegistration({ ...https, rpId: "192.0.2.1", origin: "https://192.0.2.1" }, async () => ({ verified: true, credentialId: "primary-credential", publicKey: "primary-key", counter: 0 }))).rejects.toThrow();
  });

  it("rejects an invalid P-256 assertion and any changed Safe, chain, credential, or digest binding", async () => {
    const input = {
      role: "primary" as const,
      safe: SAFE,
      chainId: 11155111,
      safeTxHash: HASH,
      challenge: CHALLENGE,
      binding: { safe: SAFE, chainId: 11155111, safeTxHash: HASH },
      rpId: "localhost",
      origin: "http://localhost:5173",
      credentialId: "primary-credential",
      response: { id: "primary-credential" },
      credential: { id: "primary-credential", publicKey: "primary-key", counter: 0 },
    };

    await expect(verifyPasskeyAssertion(input, async () => ({ verified: false, authenticationInfo: undefined }))).rejects.toThrow();
    await expect(verifyPasskeyAssertion({ ...input, chainId: 1 }, async () => ({ verified: true, authenticationInfo: undefined }))).rejects.toThrow();
    await expect(verifyPasskeyAssertion({ ...input, safe: "0x2222222222222222222222222222222222222222" as Address }, async () => ({ verified: true, authenticationInfo: undefined }))).rejects.toThrow();
    await expect(verifyPasskeyAssertion({ ...input, credentialId: "secondary-credential" }, async () => ({ verified: true, authenticationInfo: undefined }))).rejects.toThrow();
  });
});
