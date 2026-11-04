import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { hexToBytes, type Address, type Hex } from "viem";

type Json = Record<string, unknown>;

export type PasskeyRole = "primary" | "secondary";

export type PasskeyRegistrationOptions = Readonly<{
  role: PasskeyRole;
  challenge: string;
  rpId: string;
  origin: string;
  options: Readonly<Record<string, unknown>>;
}>;

export type PasskeyRegistration = Readonly<{
  role: PasskeyRole;
  credentialId: string;
  challenge: string;
  rpId: string;
  origin: string;
  response: RegistrationResponseJSON;
}>;

export type SafeAssertionOptions = Readonly<{
  role: PasskeyRole;
  safe: Address;
  chainId: number;
  safeTxHash: Hex;
  challenge: string;
  challengeBinding: Readonly<{ safe: Address; chainId: number; safeTxHash: Hex }>;
  rpId: string;
  origin: string;
  credentialId: string;
}>;

export type PasskeyRebindOptions = Readonly<{
  role: PasskeyRole;
  challenge: string;
  rpId: string;
  origin: string;
  userVerification: "required";
}>;

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url value");
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseClientData(value: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
  } catch {
    throw new Error("invalid WebAuthn client data");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid WebAuthn client data");
  return parsed as Json;
}

function stringField(value: Json, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`WebAuthn client data ${key} is invalid`);
  return result;
}

function assertCommonChallenge(
  challenge: string,
  rpId: string,
  origin: string,
  clientData: Json,
  expectedType: "webauthn.create" | "webauthn.get",
): void {
  if (stringField(clientData, "type") !== expectedType)
    throw new Error("WebAuthn ceremony type mismatch");
  if (stringField(clientData, "challenge") !== challenge)
    throw new Error("WebAuthn challenge mismatch");
  if (stringField(clientData, "origin") !== origin) throw new Error("WebAuthn origin mismatch");
  if ("crossOrigin" in clientData && clientData["crossOrigin"] !== false)
    throw new Error("WebAuthn cross-origin assertion is not accepted");
  if (!rpId) throw new Error("WebAuthn RP ID is required");
}

function assertBytes32Digest(value: Hex): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("Safe transaction hash must be bytes32");
}

export function challengeForSafeDigest(value: Hex): string {
  assertBytes32Digest(value);
  return value
    .slice(2)
    .match(/.{2}/g)
    ?.map((byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    .join("")
    ? btoa(String.fromCharCode(...hexToBytes(value)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "")
    : "";
}

function assertBinding(options: SafeAssertionOptions): void {
  assertBytes32Digest(options.safeTxHash);
  if (options.challenge !== challengeForSafeDigest(options.safeTxHash))
    throw new Error("WebAuthn challenge is not bound to the Safe transaction hash");
  if (options.challengeBinding.chainId !== options.chainId)
    throw new Error("WebAuthn chain binding mismatch");
  if (options.challengeBinding.safe.toLowerCase() !== options.safe.toLowerCase())
    throw new Error("WebAuthn Safe binding mismatch");
  if (options.challengeBinding.safeTxHash.toLowerCase() !== options.safeTxHash.toLowerCase())
    throw new Error("WebAuthn digest binding mismatch");
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0)
    throw new Error("invalid WebAuthn chain");
}

export async function createVaultPasskey(
  options: PasskeyRegistrationOptions,
): Promise<PasskeyRegistration> {
  if (options.role !== "primary" && options.role !== "secondary")
    throw new Error("unsupported passkey role");
  if (
    typeof options.options["challenge"] !== "string" ||
    options.options["challenge"] !== options.challenge
  )
    throw new Error("registration challenge mismatch");
  const rp = options.options["rp"];
  if (!rp || typeof rp !== "object" || Array.isArray(rp) || (rp as Json)["id"] !== options.rpId)
    throw new Error("registration RP ID mismatch");
  const selection = options.options["authenticatorSelection"];
  const expectedAttachment = options.role === "primary" ? "platform" : "cross-platform";
  if (
    !selection ||
    typeof selection !== "object" ||
    Array.isArray(selection) ||
    (selection as Json)["authenticatorAttachment"] !== expectedAttachment ||
    (selection as Json)["userVerification"] !== "required"
  ) {
    throw new Error(
      `${expectedAttachment} user-verified passkey is required for the ${options.role} role`,
    );
  }
  const response = await startRegistration({ optionsJSON: options.options as never });
  const clientData = parseClientData(response.response.clientDataJSON);
  assertCommonChallenge(
    options.challenge,
    options.rpId,
    options.origin,
    clientData,
    "webauthn.create",
  );
  if (
    response.type !== "public-key" ||
    !response.id ||
    response.authenticatorAttachment !== expectedAttachment
  )
    throw new Error(`registration did not use the required ${expectedAttachment} authenticator`);
  return Object.freeze({
    role: options.role,
    credentialId: response.id,
    challenge: options.challenge,
    rpId: options.rpId,
    origin: options.origin,
    response,
  });
}

export async function signSafeDigest(
  options: SafeAssertionOptions,
): Promise<AuthenticationResponseJSON> {
  if (options.role !== "primary" && options.role !== "secondary")
    throw new Error("unsupported passkey role");
  if (!options.credentialId) throw new Error("credential ID is required");
  assertBinding(options);
  const response = await startAuthentication({
    optionsJSON: {
      challenge: options.challenge,
      rpId: options.rpId,
      userVerification: "required",
      allowCredentials: [{ id: options.credentialId, type: "public-key" }],
    },
  });
  if (response.id !== options.credentialId || response.type !== "public-key")
    throw new Error("WebAuthn credential mismatch");
  const clientData = parseClientData(response.response.clientDataJSON);
  assertCommonChallenge(
    options.challenge,
    options.rpId,
    options.origin,
    clientData,
    "webauthn.get",
  );
  const authenticatorData = base64UrlToBytes(response.response.authenticatorData);
  if (authenticatorData.length < 37 || (authenticatorData[32]! & 0x04) === 0)
    throw new Error("WebAuthn user verification is required");
  return response;
}

export async function rebindPasskey(
  options: PasskeyRebindOptions,
  credentialId: string,
): Promise<AuthenticationResponseJSON> {
  if (options.role !== "primary" && options.role !== "secondary") throw new Error("unsupported passkey role");
  if (!credentialId) throw new Error("stored credential ID is required for rebind");
  if (options.userVerification !== "required") throw new Error("credential rebind requires user verification");
  const response = await startAuthentication({
    optionsJSON: {
      challenge: options.challenge,
      rpId: options.rpId,
      userVerification: "required",
      allowCredentials: [{ id: credentialId, type: "public-key" }],
    },
  });
  if (response.id !== credentialId || response.type !== "public-key") throw new Error("WebAuthn credential rebind mismatch");
  const clientData = parseClientData(response.response.clientDataJSON);
  assertCommonChallenge(options.challenge, options.rpId, options.origin, clientData, "webauthn.get");
  const authenticatorData = base64UrlToBytes(response.response.authenticatorData);
  if (authenticatorData.length < 37 || (authenticatorData[32]! & 0x01) === 0 || (authenticatorData[32]! & 0x04) === 0) throw new Error("WebAuthn user presence and verification are required");
  return response;
}
