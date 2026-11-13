import { type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { authenticateVaultPasskey, createVaultPasskey, signSafeDigest } from "./webauthn-passkey";

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
      authenticatorData: bytesEncoded(
        new Uint8Array(37).fill(0).map((value, index) => (index === 32 ? 0x05 : value)),
      ),
      signature: bytesEncoded(Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02])),
      userHandle: null,
    },
    ...overrides,
  };
}

const registrationOptions = (role: "primary" | "secondary") =>
  ({
    challenge: CHALLENGE,
    rp: { id: "localhost", name: "USDC demo" },
    user: { id: encoded("user-primary"), name: "primary", displayName: "Primary passkey" },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    authenticatorSelection: {
      authenticatorAttachment: role === "primary" ? "platform" : "cross-platform",
      userVerification: "required",
    },
  }) as const;

describe("createVaultPasskey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes a backend challenge registration without persisting credential material", async () => {
    startRegistrationMock.mockResolvedValue({
      id: CREDENTIAL,
      rawId: encoded("raw-credential"),
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: encoded({
          type: "webauthn.create",
          challenge: CHALLENGE,
          origin: "http://localhost:5173",
        }),
        attestationObject: encoded("attestation"),
      },
      clientExtensionResults: {},
    } as never);

    const registration = await createVaultPasskey({
      role: "primary",
      challenge: CHALLENGE,
      rpId: "localhost",
      origin: "http://localhost:5173",
      options: registrationOptions("primary"),
    });

    expect(startRegistrationMock).toHaveBeenCalledWith({
      optionsJSON: registrationOptions("primary"),
    });
    expect(registration).toMatchObject({
      role: "primary",
      credentialId: CREDENTIAL,
      challenge: CHALLENGE,
      rpId: "localhost",
      origin: "http://localhost:5173",
    });
    expect(JSON.stringify(registration)).not.toContain("privateKey");
  });

  it("requires a distinct cross-platform ceremony for the secondary role", async () => {
    startRegistrationMock.mockResolvedValue({
      id: "credential-secondary",
      rawId: encoded("raw-secondary"),
      type: "public-key",
      authenticatorAttachment: "cross-platform",
      response: {
        clientDataJSON: encoded({
          type: "webauthn.create",
          challenge: CHALLENGE,
          origin: "http://localhost:5173",
        }),
        attestationObject: encoded("attestation"),
      },
      clientExtensionResults: {},
    } as never);

    await expect(
      createVaultPasskey({
        role: "secondary",
        challenge: CHALLENGE,
        rpId: "localhost",
        origin: "http://localhost:5173",
        options: registrationOptions("secondary"),
      }),
    ).resolves.toMatchObject({ role: "secondary", credentialId: "credential-secondary" });
    await expect(
      createVaultPasskey({
        role: "secondary",
        challenge: CHALLENGE,
        rpId: "localhost",
        origin: "http://localhost:5173",
        options: registrationOptions("primary"),
      }),
    ).rejects.toThrow(/cross-platform/i);
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

  it("requests required user verification and returns the raw browser assertion unchanged", async () => {
    const rawAssertion = assertion();
    startAuthenticationMock.mockResolvedValue(rawAssertion as never);
    const response = await signSafeDigest(options);

    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        challenge: CHALLENGE,
        rpId: "localhost",
        userVerification: "required",
        allowCredentials: [{ id: CREDENTIAL, type: "public-key" }],
      }),
    });
    expect(response).toBe(rawAssertion);
    expect(response.response.signature).toBe(rawAssertion.response.signature);
  });

  it.each([
    ["challenge", { challenge: `${CHALLENGE.slice(0, -1)}A` }],
    [
      "safe",
      {
        challengeBinding: {
          safe: "0x2222222222222222222222222222222222222222" as Address,
          chainId: 11155111,
          safeTxHash: HASH,
        },
      },
    ],
    ["chain", { challengeBinding: { safe: SAFE, chainId: 1, safeTxHash: HASH } }],
    ["credential", { credentialId: "different-credential" }],
    ["origin", { origin: "https://evil.invalid" }],
  ])("rejects a changed %s before returning a signature", async (_field, mutation) => {
    await expect(signSafeDigest({ ...options, ...mutation } as never)).rejects.toThrow();
  });

  it("rejects assertions without user verification or with a changed origin", async () => {
    startAuthenticationMock.mockResolvedValue(
      assertion({
        response: {
          ...assertion().response,
          clientDataJSON: clientData(CHALLENGE, "https://evil.invalid"),
          authenticatorData: bytesEncoded(new Uint8Array(37).fill(0)),
        },
      }) as never,
    );
    await expect(signSafeDigest(options)).rejects.toThrow();
  });
});

it("allows a discoverable first passkey without a forced authenticator attachment", async () => {
  const options = registrationOptions("primary");
  const { authenticatorAttachment: _attachment, ...selection } = options.authenticatorSelection;
  startRegistrationMock.mockResolvedValue({
    id: CREDENTIAL,
    type: "public-key",
    authenticatorAttachment: "cross-platform",
    response: {
      clientDataJSON: encoded({
        type: "webauthn.create",
        challenge: CHALLENGE,
        origin: "http://localhost:5173",
      }),
    },
  } as never);
  await expect(
    createVaultPasskey({
      role: "primary",
      challenge: CHALLENGE,
      rpId: "localhost",
      origin: "http://localhost:5173",
      options: { ...options, authenticatorSelection: { ...selection, residentKey: "required" } },
    }),
  ).resolves.toMatchObject({ credentialId: CREDENTIAL });
});

it("selects a missing secondary reference only for an exact Safe transaction", async () => {
  startAuthenticationMock.mockResolvedValue(assertion({ id: "original-second" }) as never);
  await expect(
    signSafeDigest({
      role: "secondary",
      safe: SAFE,
      chainId: 11155111,
      safeTxHash: HASH,
      challenge: CHALLENGE,
      challengeBinding: { safe: SAFE, chainId: 11155111, safeTxHash: HASH },
      rpId: "localhost",
      origin: "http://localhost:5173",
    }),
  ).resolves.toMatchObject({ id: "original-second" });
  expect(startAuthenticationMock).toHaveBeenLastCalledWith({
    optionsJSON: { challenge: CHALLENGE, rpId: "localhost", userVerification: "required" },
  });
});

describe("discoverable application login", () => {
  beforeEach(() => vi.clearAllMocks());
  const options = {
    challenge: CHALLENGE,
    rpId: "localhost",
    origin: "http://localhost:5173",
    userVerification: "required" as const,
  };
  it("omits the credential list after browser storage is cleared", async () => {
    startAuthenticationMock.mockResolvedValue(assertion() as never);
    await authenticateVaultPasskey(options);
    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: { challenge: CHALLENGE, rpId: "localhost", userVerification: "required" },
    });
  });
  it("targets the first credential immediately after registration", async () => {
    startAuthenticationMock.mockResolvedValue(assertion() as never);
    await authenticateVaultPasskey(options, CREDENTIAL);
    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: {
        challenge: CHALLENGE,
        rpId: "localhost",
        userVerification: "required",
        allowCredentials: [{ id: CREDENTIAL, type: "public-key" }],
      },
    });
    startAuthenticationMock.mockResolvedValue(assertion({ id: "different" }) as never);
    await expect(authenticateVaultPasskey(options, CREDENTIAL)).rejects.toThrow(
      /credential mismatch/i,
    );
  });
  it("preserves synced-provider transport hints when verifying the freshly created first key", async () => {
    startAuthenticationMock.mockResolvedValue(assertion() as never);
    await authenticateVaultPasskey(
      { ...options, credentialTransports: ["hybrid", "internal"] },
      CREDENTIAL,
    );
    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: {
        challenge: CHALLENGE,
        rpId: "localhost",
        userVerification: "required",
        allowCredentials: [
          { id: CREDENTIAL, type: "public-key", transports: ["hybrid", "internal"] },
        ],
      },
    });
  });
  it("rejects substituted login challenge, origin, ceremony and missing presence or verification", async () => {
    const invalid = [
      { ...assertion().response, clientDataJSON: clientData("other") },
      { ...assertion().response, clientDataJSON: clientData(CHALLENGE, "https://other.invalid") },
      {
        ...assertion().response,
        clientDataJSON: encoded({
          type: "webauthn.create",
          challenge: CHALLENGE,
          origin: options.origin,
        }),
      },
      ...[0x00, 0x01, 0x04].map((flags) => ({
        ...assertion().response,
        authenticatorData: bytesEncoded(
          Uint8Array.from({ length: 37 }, (_, index) => (index === 32 ? flags : 0)),
        ),
      })),
    ];
    for (const response of invalid) {
      startAuthenticationMock.mockResolvedValueOnce(assertion({ response }) as never);
      await expect(authenticateVaultPasskey(options)).rejects.toThrow();
    }
  });
});
