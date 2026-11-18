import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { encodeAbiParameters, toHex, type Hex } from "viem";

export type AutomatedCredential = Readonly<{ privateKeyPem: string; x: bigint; y: bigint }>;

export function createAutomatedCredential(): AutomatedCredential {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    x: BigInt(toHex(Buffer.from(publicKey.x!, "base64url"))),
    y: BigInt(toHex(Buffer.from(publicKey.y!, "base64url"))),
  };
}

export function signWebAuthn(credential: AutomatedCredential, challenge: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(challenge)) throw new Error("WebAuthn challenge must be a bytes32 digest");
  const key = createPrivateKey(credential.privateKeyPem);
  const pub = createPublicKey(key).export({ format: "jwk" });
  if (pub.crv !== "P-256" || BigInt(toHex(Buffer.from(pub.x!, "base64url"))) !== credential.x || BigInt(toHex(Buffer.from(pub.y!, "base64url"))) !== credential.y) throw new Error("credential public key mismatch");
  const clientDataFields = '"origin":"https://vault-test.invalid","crossOrigin":false';
  const clientData = `{"type":"webauthn.get","challenge":"${Buffer.from(challenge.slice(2), "hex").toString("base64url")}",${clientDataFields}}`;
  // This is a software test authenticator, not evidence of physical user verification.
  const authenticatorData = Buffer.concat([createHash("sha256").update("vault-test.invalid").digest(), Buffer.from([0x05, 0, 0, 0, 0])]);
  const message = Buffer.concat([authenticatorData, createHash("sha256").update(clientData).digest()]);
  const signature = sign("sha256", message, { key, dsaEncoding: "ieee-p1363" });
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
    [toHex(authenticatorData), clientDataFields, BigInt(toHex(signature.subarray(0, 32))), BigInt(toHex(signature.subarray(32)))],
  );
}
