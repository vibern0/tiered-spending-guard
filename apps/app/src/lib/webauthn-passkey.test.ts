import { decodeAbiParameters, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { createVaultPasskey, signSafeDigest } from "./webauthn-passkey";

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

const startAuthenticationMock = vi.mocked(startAuthentication);
const startRegistrationMock = vi.mocked(startRegistration);
const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CHALLENGE = Buffer.from(HASH.slice(2), "hex").toString("base64url");
const CREDENTIAL = "credential-primary";

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function bytesEncoded(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function clientData(challenge = CHALLENGE, origin = "http://localhost:5173"): string {
  return encoded({ type: "webauthn.get", challenge, origin, crossOrigin: false });
}

function assertion(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL,
    rawId: encoded("raw-credential"),
    type: "public-key",
    response: {
      clientDataJSON: clientData(),
      authenticatorData: bytesEncoded(new Uint8Array(37).fill(0).map((value, index) => index === 32 ? 0x05 : value)),
      signature: bytesEncoded(new Uint8Array(64).fill(7)),
      userHandle: null,
    },
    ...overrides,
  };
}

const registrationOptions = {
  challenge: CHALLENGE,
  rp: { id: "localhost", name: "USDC demo" },
  user: { id: encoded("user-primary"), name: "primary", displayName: "Primary passkey" },
  pubKeyCredParams: [{ alg: -7, type: "public-key" }],
  authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
} as const;

describe("createVaultPasskey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes a backend challenge registration without persisting credential material", async () => {
    startRegistrationMock.mockResolvedValue({
      id: CREDENTIAL,
      rawId: encoded("raw-credential"),
      type: "public-key",
      response: { clientDataJSON: encoded({ type: "webauthn.create", challenge: CHALLENGE, origin: "http://localhost:5173" }), attestationObject: encoded("attestation") },
      clientExtensionResults: {},
    } as never);

    const registration = await createVaultPasskey({
      role: "primary",
      challenge: CHALLENGE,
      rpId: "localhost",
      origin: "http://localhost:5173",
      options: registrationOptions,
    });

    expect(startRegistrationMock).toHaveBeenCalledWith({ optionsJSON: registrationOptions });
    expect(registration).toMatchObject({ role: "primary", credentialId: CREDENTIAL, challenge: CHALLENGE, rpId: "localhost", origin: "http://localhost:5173" });
    expect(JSON.stringify(registration)).not.toContain("privateKey");
  });
});

describe("signSafeDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startAuthenticationMock.mockResolvedValue(assertion() as never);
  });

  const options = {
    role: "primary" as const,
    safe: SAFE,
    chainId: 11155111,
    safeTxHash: HASH,
    challenge: CHALLENGE,
    challengeBinding: { safe: SAFE, chainId: 11155111, safeTxHash: HASH },
    rpId: "localhost",
    origin: "http://localhost:5173",
    credentialId: CREDENTIAL,
  };

  it("requests required user verification for the bound credential and emits Safe ABI encoding", async () => {
    const signature = await signSafeDigest(options);

    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ challenge: CHALLENGE, rpId: "localhost", userVerification: "required", allowCredentials: [{ id: CREDENTIAL, type: "public-key" }] }),
    });
    const [authenticatorData, clientDataFields, r, s] = decodeAbiParameters(
      [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
      signature,
    );
    expect(authenticatorData).toMatch(/^0x/);
    expect(clientDataFields).toContain('"origin":"http://localhost:5173"');
    expect(r).toBe(0x0707070707070707070707070707070707070707070707070707070707070707n);
    expect(s).toBe(r);
  });

  it.each([
    ["challenge", { challenge: `${CHALLENGE.slice(0, -1)}A` }],
    ["safe", { challengeBinding: { safe: "0x2222222222222222222222222222222222222222" as Address, chainId: 11155111, safeTxHash: HASH } }],
    ["chain", { challengeBinding: { safe: SAFE, chainId: 1, safeTxHash: HASH } }],
    ["credential", { credentialId: "different-credential" }],
    ["origin", { origin: "https://evil.invalid" }],
  ])("rejects a changed %s before returning a signature", async (_field, mutation) => {
    await expect(signSafeDigest({ ...options, ...mutation } as never)).rejects.toThrow();
  });

  it("rejects assertions without user verification or with a changed origin", async () => {
    startAuthenticationMock.mockResolvedValue(assertion({ response: { ...assertion().response, clientDataJSON: clientData(CHALLENGE, "https://evil.invalid"), authenticatorData: bytesEncoded(new Uint8Array(37).fill(0)) } }) as never);
    await expect(signSafeDigest(options)).rejects.toThrow();
  });
});
