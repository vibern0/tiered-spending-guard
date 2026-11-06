import type { Address, Hex } from "viem";
import { bytesToHex, encodeAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { decodeP256Credential, parseP256DerSignature } from "../src/webauthn-signature";
import { encodeP256CosePublicKey, verifyPasskeyAssertion, verifyPasskeyRebind, verifyPasskeyRegistration } from "../src/webauthn";

const SAFE = "0x1111111111111111111111111111111111111111" as Address;
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const CHALLENGE = Buffer.from(HASH.slice(2), "hex").toString("base64url");
const ORIGIN = "http://localhost:5173";
const AUTHENTICATOR_DATA = Uint8Array.from([...new Uint8Array(32), 0x05, 0, 0, 0, 1]);

function base64url(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

function coseKey(options: { alg?: number; curve?: number; x?: Uint8Array; y?: Uint8Array } = {}): Uint8Array {
  const x = options.x ?? new Uint8Array(32).fill(0x11);
  const y = options.y ?? new Uint8Array(32).fill(0x22);
  return Uint8Array.from([0xa5, 0x01, 0x02, 0x03, options.alg === undefined ? 0x26 : options.alg, 0x20, options.curve ?? 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]);
}

function integer(bytes: readonly number[]): number[] {
  return [0x02, bytes.length, ...bytes];
}

function der(r: readonly number[], s: readonly number[], trailing: readonly number[] = []): Uint8Array {
  const body = [...integer(r), ...integer(s)];
  return Uint8Array.from([0x30, body.length, ...body, ...trailing]);
}

const R_BYTES = [0x00, 0x80, ...new Array(31).fill(0x11)];
const S_BYTES = [0x01, ...new Array(30).fill(0x22)];
const VALID_DER = der(R_BYTES, S_BYTES);
const CLIENT_DATA_TEXT = `{"type":"webauthn.get","challenge":"${CHALLENGE}","origin":"${ORIGIN}","crossOrigin":false,"escaped":"\\u0061"}`;

function assertion(overrides: Record<string, unknown> = {}): AuthenticationResponseJSON {
  return {
    id: "primary-credential",
    rawId: base64url("primary-credential"),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: base64url(CLIENT_DATA_TEXT),
      authenticatorData: base64url(AUTHENTICATOR_DATA),
      signature: base64url(VALID_DER),
      userHandle: undefined,
    },
    clientExtensionResults: {},
    ...overrides,
  } as AuthenticationResponseJSON;
}

const registrationResponse = (id: string, attachment: "platform" | "cross-platform"): RegistrationResponseJSON => ({
  id,
  rawId: base64url(id),
  type: "public-key",
  authenticatorAttachment: attachment,
  response: { clientDataJSON: base64url(`{"type":"webauthn.create","challenge":"${CHALLENGE}","origin":"${ORIGIN}","crossOrigin":false}`), attestationObject: base64url("attestation") },
  clientExtensionResults: {},
});

describe("backend WebAuthn registration", () => {
  it("accepts ES256/P-256 primary platform and secondary cross-platform credentials", async () => {
    const primaryKey = coseKey();
    const secondaryKey = coseKey({ x: new Uint8Array(32).fill(0x33), y: new Uint8Array(32).fill(0x44) });
    const primary = await verifyPasskeyRegistration({ role: "primary", credentialId: "primary-credential", challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response: registrationResponse("primary-credential", "platform") }, async () => ({ verified: true, credentialId: "primary-credential", publicKey: primaryKey, counter: 0 }));
    const secondary = await verifyPasskeyRegistration({ role: "secondary", credentialId: "secondary-credential", challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response: registrationResponse("secondary-credential", "cross-platform") }, async () => ({ verified: true, credentialId: "secondary-credential", publicKey: secondaryKey, counter: 0 }));

    expect(primary).toMatchObject({ role: "primary", x: BigInt(bytesToHex(new Uint8Array(32).fill(0x11))), y: BigInt(bytesToHex(new Uint8Array(32).fill(0x22))) });
    expect(secondary.credentialId).not.toBe(primary.credentialId);
    expect(secondary.x).not.toBe(primary.x);
  });

  it("rejects wrong attachment, algorithm, curve, RP, and origin", async () => {
    const verify = (publicKey: Uint8Array) => async () => ({ verified: true, credentialId: "primary-credential", publicKey, counter: 0 });
    const input = { role: "primary" as const, credentialId: "primary-credential", challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response: registrationResponse("primary-credential", "platform") };
    await expect(verifyPasskeyRegistration({ ...input, response: registrationResponse("primary-credential", "cross-platform") }, verify(coseKey()))).rejects.toThrow(/platform/i);
    await expect(verifyPasskeyRegistration(input, verify(coseKey({ alg: 0x27 })))).rejects.toThrow(/ES256/i);
    await expect(verifyPasskeyRegistration(input, verify(coseKey({ curve: 0x02 })))).rejects.toThrow(/P-256/i);
    await expect(verifyPasskeyRegistration({ ...input, origin: "https://evil.invalid" }, verify(coseKey()))).rejects.toThrow();
    await expect(verifyPasskeyRegistration({ ...input, rpId: "192.0.2.1", origin: "https://192.0.2.1" }, verify(coseKey()))).rejects.toThrow();
  });
});

describe("strict P-256 signature decoding", () => {
  it("accepts canonical DER with a required leading zero and a short integer", () => {
    expect(parseP256DerSignature(VALID_DER)).toEqual({
      r: BigInt(bytesToHex(Uint8Array.from(R_BYTES.slice(1)))),
      s: BigInt(bytesToHex(Uint8Array.from(S_BYTES))),
    });
  });

  it.each([
    ["nonminimal", der([0x00, 0x7f], [0x01])],
    ["negative", der([0x80], [0x01])],
    ["oversized", der([0x00, 0x80, ...new Array(32).fill(0x01)], [0x01])],
    ["trailing", der([0x01], [0x02], [0x00])],
    ["truncated", Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01])],
  ])("rejects %s DER", (_name, value) => {
    expect(() => parseP256DerSignature(value)).toThrow();
  });

  it("decodes only complete ES256/P-256 COSE credentials", () => {
    expect(decodeP256Credential(coseKey())).toEqual({
      x: BigInt(bytesToHex(new Uint8Array(32).fill(0x11))),
      y: BigInt(bytesToHex(new Uint8Array(32).fill(0x22))),
    });
    expect(() => decodeP256Credential(coseKey({ x: new Uint8Array(31) }))).toThrow();
  });
});

describe("backend WebAuthn assertion binding", () => {
  const credential = { role: "primary" as const, id: "primary-credential", publicKey: coseKey(), counter: 4, x: 1n, y: 2n };
  const input = {
    role: "primary" as const,
    safe: SAFE,
    chainId: 11155111,
    safeTxHash: HASH,
    challenge: CHALLENGE,
    binding: { safe: SAFE, chainId: 11155111, safeTxHash: HASH },
    rpId: "localhost",
    origin: ORIGIN,
    credentialId: "primary-credential",
    response: assertion(),
    credential,
  };

  it("verifies first, preserves the exact client-data suffix, and emits the onchain payload", async () => {
    const approval = await verifyPasskeyAssertion(input, async () => ({ verified: true, authenticationInfo: { newCounter: 5 } }));
    expect(approval).toEqual({
      role: "primary",
      credentialId: "primary-credential",
      counter: 5,
      payload: encodeAbiParameters(
        [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
        [bytesToHex(AUTHENTICATOR_DATA), `"origin":"${ORIGIN}","crossOrigin":false,"escaped":"\\u0061"`, BigInt(bytesToHex(Uint8Array.from(R_BYTES.slice(1)))), BigInt(bytesToHex(Uint8Array.from(S_BYTES)))],
      ),
    });
  });

  it.each([
    ["chain", { chainId: 1 }],
    ["Safe", { safe: "0x2222222222222222222222222222222222222222" as Address }],
    ["credential", { credentialId: "secondary-credential" }],
    ["role", { role: "secondary" as const }],
  ])("rejects changed %s binding", async (_name, mutation) => {
    await expect(verifyPasskeyAssertion({ ...input, ...mutation } as never, async () => ({ verified: true, authenticationInfo: { newCounter: 5 } }))).rejects.toThrow();
  });

  it("rejects altered client JSON order, origin, challenge, type, crossOrigin, UV, and DER", async () => {
    const changed = (text: string, authData = AUTHENTICATOR_DATA, signature = VALID_DER) => ({ ...input, response: assertion({ response: { ...assertion().response, clientDataJSON: base64url(text), authenticatorData: base64url(authData), signature: base64url(signature) } }) });
    const verifier = async () => ({ verified: true, authenticationInfo: { newCounter: 5 } });
    const cases = [
      changed(`{"origin":"${ORIGIN}","type":"webauthn.get","challenge":"${CHALLENGE}","crossOrigin":false}`),
      changed(CLIENT_DATA_TEXT.replace(ORIGIN, "https://evil.invalid")),
      changed(CLIENT_DATA_TEXT.replace(CHALLENGE, "wrong")),
      changed(CLIENT_DATA_TEXT.replace("webauthn.get", "webauthn.create")),
      changed(CLIENT_DATA_TEXT.replace("false", "true")),
      changed(CLIENT_DATA_TEXT, Uint8Array.from([...new Uint8Array(32), 0x01, 0, 0, 0, 1])),
      changed(CLIENT_DATA_TEXT, AUTHENTICATOR_DATA, der([0x00, 0x7f], [0x01])),
    ];
    for (const candidate of cases) await expect(verifyPasskeyAssertion(candidate as never, verifier)).rejects.toThrow();
  });

  it("rejects failed verification and counter rollback", async () => {
    await expect(verifyPasskeyAssertion(input, async () => ({ verified: false }))).rejects.toThrow(/not verified/i);
    await expect(verifyPasskeyAssertion(input, async () => ({ verified: true, authenticationInfo: { newCounter: 3 } }))).rejects.toThrow(/counter/i);
  });
});

describe("backend recovered-credential rebind", () => {
  it("encodes reviewed coordinates as the canonical ES256 COSE key and accepts the credential ID only from a verified assertion", async () => {
    const x = BigInt(bytesToHex(new Uint8Array(32).fill(0x11)));
    const y = BigInt(bytesToHex(new Uint8Array(32).fill(0x22)));
    expect(encodeP256CosePublicKey({ x, y })).toEqual(coseKey());
    const response = assertion();
    const rebound = await verifyPasskeyRebind({ role: "primary", coordinates: { x, y }, challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response }, async (input) => {
      expect(input.credential.id).toBe(response.id);
      expect(input.credential.publicKey).toEqual(coseKey());
      expect(input.credential.counter).toBe(0);
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    });
    expect(rebound).toMatchObject({ role: "primary", id: response.id, credentialId: response.id, counter: 1, x, y });
  });

  it("rejects missing UV/UP, counter rollback, and a role-key mismatch", async () => {
    const coordinates = { x: BigInt(bytesToHex(new Uint8Array(32).fill(0x11))), y: BigInt(bytesToHex(new Uint8Array(32).fill(0x22))) };
    const noUv = assertion({ response: { ...assertion().response, authenticatorData: base64url(Uint8Array.from([...new Uint8Array(32), 0x01, 0, 0, 0, 1])) } });
    await expect(verifyPasskeyRebind({ role: "primary", coordinates, challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response: noUv }, async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }))).rejects.toThrow(/presence|verification/i);
    await expect(verifyPasskeyRebind({ role: "primary", coordinates, challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response: assertion() }, async () => ({ verified: true, authenticationInfo: { newCounter: -1 } }))).rejects.toThrow(/counter/i);
    await expect(verifyPasskeyRebind({ role: "secondary", coordinates: { ...coordinates, x: coordinates.x + 1n }, challenge: CHALLENGE, rpId: "localhost", origin: ORIGIN, response: assertion() }, async (input) => {
      if (input.credential.x !== coordinates.x) throw new Error("wrong role key");
      return { verified: true, authenticationInfo: { newCounter: 1 } };
    })).rejects.toThrow(/role key/i);
  });
});

describe("durable approval replay identity", () => {
  it("normalizes the P-256 s ambiguity without changing the Safe payload", async () => {
    const { passkeyApprovalFingerprint } = await import("../src/webauthn");
    const parameters = [{type:"bytes"},{type:"string"},{type:"uint256"},{type:"uint256"}] as const;
    const order = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
    const approval = {role:"primary" as const, credentialId:"key", counter:0, payload:encodeAbiParameters(parameters,["0x05","signed origin",3n,4n])};
    const flipped = {...approval,payload:encodeAbiParameters(parameters,["0x05","signed origin",3n,order-4n])};
    expect(passkeyApprovalFingerprint(approval,HASH)).toBe(passkeyApprovalFingerprint(flipped,HASH));
    expect(passkeyApprovalFingerprint({...approval,role:"secondary"},HASH)).not.toBe(passkeyApprovalFingerprint(approval,HASH));
  });
});
