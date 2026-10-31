import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { hexToBytes, type Address, type Hex } from "viem";
import { assertBackendWebAuthnIdentity } from "./config";

export type BackendPasskeyRole = "primary" | "secondary";
export type RegistrationResponse = Readonly<{
  role: BackendPasskeyRole;
  credentialId: string;
  challenge: string;
  rpId: string;
  origin: string;
  response: unknown;
}>;

export type StoredCredential = Readonly<{ id: string; publicKey: Uint8Array | string; counter: number }>;
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
  response: unknown;
  credential: StoredCredential;
}>;

type RegistrationVerification = Readonly<{ verified: boolean; credentialId: string; publicKey: Uint8Array | string; counter: number }>;
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
  return { verified: true, credentialId: Buffer.from(result.registrationInfo.credential.id).toString("base64url"), publicKey: result.registrationInfo.credential.publicKey, counter: result.registrationInfo.credential.counter };
}

async function defaultAssertionVerifier(input: Readonly<{ response: unknown; credential: StoredCredential; challenge: string; rpId: string; origin: string }>): Promise<AssertionVerification> {
  const publicKey = typeof input.credential.publicKey === "string" ? Uint8Array.from(Buffer.from(input.credential.publicKey, "base64url")) : input.credential.publicKey;
  const result = await verifyAuthenticationResponse({
    response: input.response as never,
    expectedChallenge: input.challenge,
    expectedOrigin: input.origin,
    expectedRPID: input.rpId,
    requireUserVerification: true,
    credential: { id: input.credential.id, publicKey: publicKey as Uint8Array<ArrayBuffer>, counter: input.credential.counter },
  });
  return { verified: result.verified, authenticationInfo: result.authenticationInfo && { newCounter: result.authenticationInfo.newCounter } };
}

export async function verifyPasskeyRegistration(input: RegistrationResponse, verifier: RegistrationVerifier = defaultRegistrationVerifier): Promise<StoredCredential & Readonly<{ role: BackendPasskeyRole; credentialId: string }>> {
  role(input.role);
  assertBackendWebAuthnIdentity(input.rpId === "localhost" ? "local" : "https", input.origin, input.rpId);
  if (!input.credentialId || input.credentialId !== (input.response as { id?: unknown })["id"]) throw new Error("registration credential binding mismatch");
  const result = await verifier({ response: input.response, challenge: input.challenge, rpId: input.rpId, origin: input.origin });
  if (!result.verified || result.credentialId !== input.credentialId || !Number.isSafeInteger(result.counter) || result.counter < 0) throw new Error("WebAuthn registration was not verified");
  return Object.freeze({ role: input.role, id: result.credentialId, credentialId: result.credentialId, publicKey: result.publicKey, counter: result.counter });
}

export async function verifyPasskeyAssertion(input: AssertionInput, verifier: AssertionVerifier = defaultAssertionVerifier): Promise<Readonly<{ verified: true; counter: number }>> {
  assertSafeBinding(input);
  if (input.credentialId !== (input.response as { id?: unknown })["id"]) throw new Error("WebAuthn assertion credential binding mismatch");
  const result = await verifier({ response: input.response, credential: input.credential, challenge: input.challenge, rpId: input.rpId, origin: input.origin });
  if (!result.verified) throw new Error("WebAuthn assertion was not verified");
  const counter = result.authenticationInfo?.newCounter ?? input.credential.counter;
  if (!Number.isSafeInteger(counter) || counter < input.credential.counter) throw new Error("WebAuthn counter is invalid");
  return { verified: true, counter };
}
