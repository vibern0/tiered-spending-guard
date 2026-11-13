import {
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
	bytesToHex,
	decodeAbiParameters,
	encodeAbiParameters,
	keccak256,
	hexToBytes,
	type Address,
	type Hex,
} from "viem";
import { assertBackendWebAuthnIdentity } from "../config/config";
import {
	decodeP256Credential,
	decodeWebAuthnField,
	extractClientDataSuffix,
	parseP256DerSignature,
} from "./signatures";

export type BackendPasskeyRole = "primary" | "secondary";
export type RegistrationResponse = Readonly<{
	role: BackendPasskeyRole;
	credentialId: string;
	challenge: string;
	rpId: string;
	origin: string;
	response: RegistrationResponseJSON;
}>;

export type StoredCredential = Readonly<{
	backupEligible?: boolean;
	backedUp?: boolean;
	transports?: readonly string[];
	role: BackendPasskeyRole;
	id: string;
	publicKey: Uint8Array;
	counter: number;
	x: bigint;
	y: bigint;
}>;
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

export type VerifiedPasskeyApproval = Readonly<{
	role: BackendPasskeyRole;
	credentialId: string;
	counter: number;
	payload: Hex;
}>;

type RegistrationVerification = Readonly<{
	verified: boolean;
	credentialId: string;
	publicKey: Uint8Array;
	counter: number;
	backupEligible?: boolean;
	backedUp?: boolean;
}>;
type AssertionVerification = Readonly<{
	verified: boolean;
	authenticationInfo?: Readonly<{ newCounter?: number }>;
}>;
export type RegistrationVerifier = (
	input: Readonly<{ response: unknown; challenge: string; rpId: string; origin: string }>,
) => Promise<RegistrationVerification>;
export type AssertionVerifier = (
	input: Readonly<{
		response: unknown;
		credential: StoredCredential;
		challenge: string;
		rpId: string;
		origin: string;
	}>,
) => Promise<AssertionVerification>;

const challengeForDigest = (digest: Hex): string =>
	Buffer.from(hexToBytes(digest)).toString("base64url");

function role(role: string): asserts role is BackendPasskeyRole {
	if (role !== "primary" && role !== "secondary") throw new Error("unsupported passkey role");
}

function assertSafeBinding(input: AssertionInput): void {
	role(input.role);
	if (input.chainId !== 11155111 || input.binding.chainId !== input.chainId)
		throw new Error("WebAuthn chain binding mismatch");
	if (input.binding.safe.toLowerCase() !== input.safe.toLowerCase())
		throw new Error("WebAuthn Safe binding mismatch");
	if (input.binding.safeTxHash.toLowerCase() !== input.safeTxHash.toLowerCase())
		throw new Error("WebAuthn digest binding mismatch");
	if (input.challenge !== challengeForDigest(input.safeTxHash))
		throw new Error("WebAuthn challenge is not the Safe digest");
	if (input.credentialId !== input.credential.id)
		throw new Error("WebAuthn credential binding mismatch");
}

async function defaultRegistrationVerifier(
	input: Readonly<{ response: unknown; challenge: string; rpId: string; origin: string }>,
): Promise<RegistrationVerification> {
	const result = await verifyRegistrationResponse({
		response: input.response as never,
		expectedChallenge: input.challenge,
		expectedOrigin: input.origin,
		expectedRPID: input.rpId,
		requireUserVerification: true,
	});
	if (!result.verified || !result.registrationInfo)
		throw new Error("WebAuthn registration was not verified");
	return {
		verified: true,
		credentialId: result.registrationInfo.credential.id,
		publicKey: result.registrationInfo.credential.publicKey,
		counter: result.registrationInfo.credential.counter,
		backupEligible: result.registrationInfo.credentialDeviceType === "multiDevice",
		backedUp: result.registrationInfo.credentialBackedUp,
	};
}

async function defaultAssertionVerifier(
	input: Readonly<{
		response: unknown;
		credential: StoredCredential;
		challenge: string;
		rpId: string;
		origin: string;
	}>,
): Promise<AssertionVerification> {
	const result = await verifyAuthenticationResponse({
		response: input.response as never,
		expectedChallenge: input.challenge,
		expectedOrigin: input.origin,
		expectedRPID: input.rpId,
		requireUserVerification: true,
		credential: {
			id: input.credential.id,
			publicKey: input.credential.publicKey as Uint8Array<ArrayBuffer>,
			counter: input.credential.counter,
		},
	});
	return {
		verified: result.verified,
		authenticationInfo: result.authenticationInfo && {
			newCounter: result.authenticationInfo.newCounter,
		},
	};
}

export async function verifyPasskeyRegistration(
	input: RegistrationResponse,
	verifier: RegistrationVerifier = defaultRegistrationVerifier,
): Promise<StoredCredential & Readonly<{ credentialId: string }>> {
	role(input.role);
	assertBackendWebAuthnIdentity(
		input.rpId === "localhost" ? "local" : "https",
		input.origin,
		input.rpId,
	);
	if (
		!input.credentialId ||
		input.credentialId !== input.response.id ||
		input.response.type !== "public-key"
	)
		throw new Error("registration credential binding mismatch");
	const result = await verifier({
		response: input.response,
		challenge: input.challenge,
		rpId: input.rpId,
		origin: input.origin,
	});
	if (
		!result.verified ||
		result.credentialId !== input.credentialId ||
		!Number.isSafeInteger(result.counter) ||
		result.counter < 0
	)
		throw new Error("WebAuthn registration was not verified");
	if (input.role === "secondary" && input.response.authenticatorAttachment !== "cross-platform")
		throw new Error("secondary registration must use a cross-platform authenticator");
	const coordinates = decodeP256Credential(result.publicKey);
	return Object.freeze({
		role: input.role,
		id: result.credentialId,
		credentialId: result.credentialId,
		publicKey: result.publicKey,
		counter: result.counter,
		...coordinates,
		...(result.backupEligible === undefined
			? {}
			: { backupEligible: result.backupEligible, backedUp: result.backedUp }),
		...(input.response.response.transports
			? { transports: input.response.response.transports }
			: {}),
	});
}

export async function verifyPasskeyAssertion(
	input: AssertionInput,
	verifier: AssertionVerifier = defaultAssertionVerifier,
): Promise<VerifiedPasskeyApproval> {
	assertSafeBinding(input);
	assertBackendWebAuthnIdentity(
		input.rpId === "localhost" ? "local" : "https",
		input.origin,
		input.rpId,
	);
	if (
		input.credential.role !== input.role ||
		input.credentialId !== input.response.id ||
		input.response.type !== "public-key"
	)
		throw new Error("WebAuthn assertion credential binding mismatch");
	const result = await verifier({
		response: input.response,
		credential: input.credential,
		challenge: input.challenge,
		rpId: input.rpId,
		origin: input.origin,
	});
	if (!result.verified) throw new Error("WebAuthn assertion was not verified");
	const counter = result.authenticationInfo?.newCounter ?? input.credential.counter;
	if (!Number.isSafeInteger(counter) || counter < input.credential.counter)
		throw new Error("WebAuthn counter is invalid");
	const authenticatorData = decodeWebAuthnField(
		input.response.response.authenticatorData,
		"WebAuthn authenticatorData",
	);
	if (
		authenticatorData.length < 37 ||
		(authenticatorData[32]! & 0x01) === 0 ||
		(authenticatorData[32]! & 0x04) === 0
	)
		throw new Error("WebAuthn user presence and verification are required");
	const clientDataSuffix = extractClientDataSuffix(input.response.response.clientDataJSON, {
		challenge: input.challenge,
		origin: input.origin,
	});
	const signature = parseP256DerSignature(
		decodeWebAuthnField(input.response.response.signature, "WebAuthn signature"),
	);
	const payload = encodeAbiParameters(
		[{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
		[bytesToHex(authenticatorData), clientDataSuffix, signature.r, signature.s],
	);
	return Object.freeze({ role: input.role, credentialId: input.credentialId, counter, payload });
}

export { challengeForDigest };

/** Backend-only sign-in. Never creates a Safe signature payload. */
export async function verifyPasskeyLogin(
	input: Readonly<{
		credential: StoredCredential;
		response: AuthenticationResponseJSON;
		challenge: string;
		rpId: string;
		origin: string;
		userHandle?: string;
		allowMissingUserHandle?: boolean;
	}>,
	verifier: AssertionVerifier = defaultAssertionVerifier,
): Promise<number> {
	assertBackendWebAuthnIdentity(
		input.rpId === "localhost" ? "local" : "https",
		input.origin,
		input.rpId,
	);
	if (
		input.credential.role !== "primary" ||
		input.response.id !== input.credential.id ||
		input.response.type !== "public-key"
	)
		throw new Error("first passkey authentication required");
	if (
		input.userHandle !== undefined &&
		input.response.response.userHandle !== input.userHandle &&
		!(input.allowMissingUserHandle && input.response.response.userHandle == null)
	)
		throw new Error("passkey user handle mismatch");
	const result = await verifier({ ...input, response: input.response });
	if (!result.verified) throw new Error("passkey login was not verified");
	const counter = result.authenticationInfo?.newCounter ?? input.credential.counter;
	if (!Number.isSafeInteger(counter) || counter < input.credential.counter)
		throw new Error("WebAuthn counter is invalid");
	const data = decodeWebAuthnField(
		input.response.response.authenticatorData,
		"WebAuthn authenticatorData",
	);
	if (data.length < 37 || (data[32]! & 5) !== 5)
		throw new Error("WebAuthn user presence and verification required");
	extractClientDataSuffix(input.response.response.clientDataJSON, {
		challenge: input.challenge,
		origin: input.origin,
	});
	return counter;
}

/** Fingerprint only; leaves the exact Safe payload/signature format unchanged. */
export function passkeyApprovalFingerprint(
	approval: VerifiedPasskeyApproval,
	safeTxHash: Hex,
): Hex {
	const parameters = [
		{ type: "bytes" },
		{ type: "string" },
		{ type: "uint256" },
		{ type: "uint256" },
	] as const;
	const [authenticatorData, clientData, r, s] = decodeAbiParameters(parameters, approval.payload);
	// SEC2 P-256 order, also pinned OpenZeppelin P256.N. Normalize the
	// ECDSA (r,s)/(r,N-s) ambiguity before recording one-use verification.
	const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
	if (r <= 0n || s <= 0n || r >= order || s >= order)
		throw new Error("invalid P-256 signature scalars");
	const canonical = encodeAbiParameters(parameters, [
		authenticatorData,
		clientData,
		r,
		s > order / 2n ? order - s : s,
	]);
	return keccak256(
		encodeAbiParameters(
			[{ type: "bytes32" }, { type: "string" }, { type: "string" }, { type: "bytes" }],
			[safeTxHash, approval.role, approval.credentialId, canonical],
		),
	);
}
