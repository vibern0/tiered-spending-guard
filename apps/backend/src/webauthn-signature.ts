import { decodeCredentialPublicKey, cose } from "@simplewebauthn/server/helpers";
import { bytesToHex } from "viem";

function strictBase64Url(value: string, label: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${label} is not canonical base64url`);
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== value)
    throw new Error(`${label} is not canonical base64url`);
  return bytes;
}

export function decodeP256Credential(publicKey: Uint8Array | string): { x: bigint; y: bigint } {
  const bytes =
    typeof publicKey === "string" ? strictBase64Url(publicKey, "credential public key") : publicKey;
  let decoded: ReturnType<typeof decodeCredentialPublicKey>;
  try {
    decoded = decodeCredentialPublicKey(bytes);
  } catch {
    throw new Error("credential public key is not valid COSE");
  }
  if (!cose.isCOSEPublicKeyEC2(decoded) || decoded.get(cose.COSEKEYS.kty) !== cose.COSEKTY.EC2)
    throw new Error("credential public key must use EC2");
  if (decoded.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256)
    throw new Error("credential public key must use ES256");
  if (decoded.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256)
    throw new Error("credential public key must use P-256");
  const x = decoded.get(cose.COSEKEYS.x);
  const y = decoded.get(cose.COSEKEYS.y);
  if (!x || !y || x.length !== 32 || y.length !== 32)
    throw new Error("P-256 credential coordinates must be exactly 32 bytes");
  return { x: BigInt(bytesToHex(x)), y: BigInt(bytesToHex(y)) };
}

function positiveInteger(bytes: Uint8Array, cursor: number): { value: bigint; cursor: number } {
  if (bytes[cursor] !== 0x02) throw new Error("P-256 DER signature is missing an INTEGER");
  const length = bytes[cursor + 1];
  if (length === undefined || length === 0 || (length & 0x80) !== 0)
    throw new Error("P-256 DER INTEGER length is invalid");
  const start = cursor + 2;
  const end = start + length;
  if (end > bytes.length) throw new Error("P-256 DER INTEGER is truncated");
  const encoded = bytes.slice(start, end);
  if ((encoded[0]! & 0x80) !== 0) throw new Error("P-256 DER INTEGER cannot be negative");
  if (encoded.length > 1 && encoded[0] === 0 && (encoded[1]! & 0x80) === 0)
    throw new Error("P-256 DER INTEGER has a nonminimal leading zero");
  const unsigned = encoded[0] === 0 ? encoded.slice(1) : encoded;
  if (unsigned.length === 0 || unsigned.length > 32)
    throw new Error("P-256 DER INTEGER is oversized");
  const value = BigInt(bytesToHex(unsigned));
  if (value === 0n) throw new Error("P-256 DER INTEGER cannot be zero");
  return { value, cursor: end };
}

export function parseP256DerSignature(bytes: Uint8Array): { r: bigint; s: bigint } {
  if (bytes.length < 8 || bytes[0] !== 0x30)
    throw new Error("P-256 signature is not a DER sequence");
  const length = bytes[1];
  if (length === undefined || (length & 0x80) !== 0 || length !== bytes.length - 2)
    throw new Error("P-256 DER sequence length is invalid");
  const r = positiveInteger(bytes, 2);
  const s = positiveInteger(bytes, r.cursor);
  if (s.cursor !== bytes.length) throw new Error("P-256 DER signature has trailing bytes");
  return { r: r.value, s: s.value };
}

export function decodeWebAuthnField(value: string, label: string): Uint8Array {
  return strictBase64Url(value, label);
}

export function extractClientDataSuffix(
  encoded: string,
  expected: Readonly<{ challenge: string; origin: string }>,
): string {
  const bytes = strictBase64Url(encoded, "WebAuthn clientDataJSON");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("WebAuthn clientDataJSON is not UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("WebAuthn clientDataJSON is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("WebAuthn clientDataJSON is invalid");
  const data = parsed as Record<string, unknown>;
  if (
    data.type !== "webauthn.get" ||
    data.challenge !== expected.challenge ||
    data.origin !== expected.origin ||
    ("crossOrigin" in data && data.crossOrigin !== false)
  )
    throw new Error("WebAuthn client data binding mismatch");
  const prefix = `{"type":"webauthn.get","challenge":"${expected.challenge}",`;
  if (!text.startsWith(prefix) || !text.endsWith("}"))
    throw new Error("WebAuthn clientDataJSON does not use the canonical signed prefix");
  const suffix = text.slice(prefix.length, -1);
  if (!suffix) throw new Error("WebAuthn clientDataJSON suffix is empty");
  return suffix;
}
