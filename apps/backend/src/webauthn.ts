import { verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { bytesToHex, encodeAbiParameters, hexToBytes, toHex, type Address, type Hex } from "viem";
import { assertBackendWebAuthnIdentity } from "./config";
import { decodeP256Credential, decodeWebAuthnField, extractClientDataSuffix, parseP256DerSignature } from "./webauthn-signature";

export type BackendPasskeyRole = "primary" | "secondary";
export type RegistrationResponse = Readonly<{
  role: BackendPasskeyRole;
  credentialId: string;
  challenge: string;
  rpId: string;
  origin: string;
  response: RegistrationResponseJSON;
}>;

export type StoredCredential = Readonly<{ role: BackendPasskeyRole; id: string; publicKey: Uint8Array; counter: number; x: bigint; y: bigint }>;
export type AssertionInput = Readonly<{
  role: BackendPasskeyRole;
  safe: Address;
  chainId: number;
  safeTxHash: Hex;
  challenge: string;
  binding: Readonly<{ safe: Address; chainId: number; safeTxHash: Hex }>;
  rpId: string;
  origin: string;
  credentialId: string;
  response: AuthenticationResponseJSON;
  credential: StoredCredential;
}>;

export type VerifiedPasskeyApproval = Readonly<{ role: BackendPasskeyRole; credentialId: string; counter: number; payload: Hex }>;
export type ReboundCredential = StoredCredential & Readonly<{ credentialId: string }>;

type RegistrationVerification = Readonly<{ verified: boolean; credentialId: string; publicKey: Uint8Array; counter: number }>;
type AssertionVerification = Readonly<{ verified: boolean; authenticationInfo?: Readonly<{ newCounter?: number }> }>;
export type RegistrationVerifier = (input: Readonly<{ response: unknown; challenge: string; rpId: string; origin: string }>) => Promise<RegistrationVerification>;
export type AssertionVerifier = (input: Readonly<{ response: unknown; credential: StoredCredential; challenge: string; rpId: string; origin: string }>) => Promise<AssertionVerification>;

const challengeForDigest = (digest: Hex): string => Buffer.from(hexToBytes(digest)).toString("base64url");

function role(role: string): asserts role is BackendPasskeyRole {
  if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey role");
}

function assertSafeBinding(input: AssertionInput): void {
  role(input.role);
  if (input.chainId !== 11155111 || input.binding.chainId !== input.chainId) throw new Error("WebAuthn chain binding mismatch");
  if (input.binding.safe.toLowerCase() !== input.safe.toLowerCase()) throw new Error("WebAuthn Safe binding mismatch");
  if (input.binding.safeTxHash.toLowerCase() !== input.safeTxHash.toLowerCase()) throw new Error("WebAuthn digest binding mismatch");
  if (input.challenge !== challengeForDigest(input.safeTxHash)) throw new Error("WebAuthn challenge is not the Safe digest");
  if (input.credentialId !== input.credential.id) throw new Error("WebAuthn credential binding mismatch");
}

async function defaultRegistrationVerifier(input: Readonly<{ response: unknown; challenge: string; rpId: string; origin: string }>): Promise<RegistrationVerification> {
  const result = await verifyRegistrationResponse({
    response: input.response as never,
    expectedChallenge: input.challenge,
    expectedOrigin: input.origin,
    expectedRPID: input.rpId,
    requireUserVerification: true,
  });
  if (!result.verified || !result.registrationInfo) throw new Error("WebAuthn registration was not verified");
  return { verified: true, credentialId: result.registrationInfo.credential.id, publicKey: result.registrationInfo.credential.publicKey, counter: result.registrationInfo.credential.counter };
}

async function defaultAssertionVerifier(input: Readonly<{ response: unknown; credential: StoredCredential; challenge: string; rpId: string; origin: string }>): Promise<AssertionVerification> {
  const result = await verifyAuthenticationResponse({
    response: input.response as never,
    expectedChallenge: input.challenge,
    expectedOrigin: input.origin,
    expectedRPID: input.rpId,
    requireUserVerification: true,
    credential: { id: input.credential.id, publicKey: input.credential.publicKey as Uint8Array<ArrayBuffer>, counter: input.credential.counter },
  });
  return { verified: result.verified, authenticationInfo: result.authenticationInfo && { newCounter: result.authenticationInfo.newCounter } };
}

export function encodeP256CosePublicKey(coordinates: Readonly<{ x: bigint; y: bigint }>): Uint8Array {
  if (coordinates.x < 0n || coordinates.y < 0n || coordinates.x >= 1n << 256n || coordinates.y >= 1n << 256n) throw new Error("P-256 coordinate is out of range");
  const x = hexToBytes(toHex(coordinates.x, { size: 32 }));
  const y = hexToBytes(toHex(coordinates.y, { size: 32 }));
  return Uint8Array.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]);
}

export async function verifyPasskeyRebind(input: Readonly<{
  role: BackendPasskeyRole;
  coordinates: Readonly<{ x: bigint; y: bigint }>;
  challenge: string;
  rpId: string;
  origin: string;
  response: AuthenticationResponseJSON;
}>, verifier: AssertionVerifier = defaultAssertionVerifier): Promise<ReboundCredential> {
  role(input.role);
  assertBackendWebAuthnIdentity(input.rpId === "localhost" ? "local" : "https", input.origin, input.rpId);
  if (!input.challenge || !input.response.id || input.response.type !== "public-key") throw new Error("WebAuthn rebind response is malformed");
  const publicKey = encodeP256CosePublicKey(input.coordinates);
  const credential = Object.freeze({ role: input.role, id: input.response.id, publicKey, counter: 0, ...input.coordinates });
  const result = await verifier({ response: input.response, credential, challenge: input.challenge, rpId: input.rpId, origin: input.origin });
  if (!result.verified) throw new Error("WebAuthn rebind assertion was not verified");
  const counter = result.authenticationInfo?.newCounter ?? 0;
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("WebAuthn rebind counter is invalid");
  const authenticatorData = decodeWebAuthnField(input.response.response.authenticatorData, "WebAuthn authenticatorData");
  if (authenticatorData.length < 37 || (authenticatorData[32]! & 0x01) === 0 || (authenticatorData[32]! & 0x04) === 0) throw new Error("WebAuthn user presence and verification are required");
  extractClientDataSuffix(input.response.response.clientDataJSON, { challenge: input.challenge, origin: input.origin });
  return Object.freeze({ ...credential, credentialId: input.response.id, counter });
}

export async function verifyPasskeyRegistration(input: RegistrationResponse, verifier: RegistrationVerifier = defaultRegistrationVerifier): Promise<StoredCredential & Readonly<{ credentialId: string }>> {
  role(input.role);
  assertBackendWebAuthnIdentity(input.rpId === "localhost" ? "local" : "https", input.origin, input.rpId);
  if (!input.credentialId || input.credentialId !== input.response.id || input.response.type !== "public-key") throw new Error("registration credential binding mismatch");
  const result = await verifier({ response: input.response, challenge: input.challenge, rpId: input.rpId, origin: input.origin });
  if (!result.verified || result.credentialId !== input.credentialId || !Number.isSafeInteger(result.counter) || result.counter < 0) throw new Error("WebAuthn registration was not verified");
  const expectedAttachment = input.role === "primary" ? "platform" : "cross-platform";
  if (input.response.authenticatorAttachment !== expectedAttachment) throw new Error(`${input.role} registration must use a ${expectedAttachment} authenticator`);
  const coordinates = decodeP256Credential(result.publicKey);
  return Object.freeze({ role: input.role, id: result.credentialId, credentialId: result.credentialId, publicKey: result.publicKey, counter: result.counter, ...coordinates });
}

export async function verifyPasskeyAssertion(input: AssertionInput, verifier: AssertionVerifier = defaultAssertionVerifier): Promise<VerifiedPasskeyApproval> {
  assertSafeBinding(input);
  assertBackendWebAuthnIdentity(input.rpId === "localhost" ? "local" : "https", input.origin, input.rpId);
  if (input.credential.role !== input.role || input.credentialId !== input.response.id || input.response.type !== "public-key") throw new Error("WebAuthn assertion credential binding mismatch");
  const result = await verifier({ response: input.response, credential: input.credential, challenge: input.challenge, rpId: input.rpId, origin: input.origin });
  if (!result.verified) throw new Error("WebAuthn assertion was not verified");
  const counter = result.authenticationInfo?.newCounter ?? input.credential.counter;
  if (!Number.isSafeInteger(counter) || counter < input.credential.counter) throw new Error("WebAuthn counter is invalid");
  const authenticatorData = decodeWebAuthnField(input.response.response.authenticatorData, "WebAuthn authenticatorData");
  if (authenticatorData.length < 37 || (authenticatorData[32]! & 0x01) === 0 || (authenticatorData[32]! & 0x04) === 0) throw new Error("WebAuthn user presence and verification are required");
  const clientDataSuffix = extractClientDataSuffix(input.response.response.clientDataJSON, { challenge: input.challenge, origin: input.origin });
  const signature = parseP256DerSignature(decodeWebAuthnField(input.response.response.signature, "WebAuthn signature"));
  const payload = encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [bytesToHex(authenticatorData), clientDataSuffix, signature.r, signature.s],
  );
  return Object.freeze({ role: input.role, credentialId: input.credentialId, counter, payload });
}

export { challengeForDigest };
