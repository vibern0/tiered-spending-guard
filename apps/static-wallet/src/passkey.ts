import {
  concatHex,
  encodeAbiParameters,
  padHex,
  sliceHex,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { toWebAuthnAccount } from "viem/account-abstraction";
import type { Credential } from "./model";
function contractSlot(owner: Address, payload: Hex): Hex {
  return concatHex([
    padHex(owner, { size: 32 }),
    toHex(65, { size: 32 }),
    "0x00",
    toHex(size(payload), { size: 32 }),
    payload,
  ]);
}
export async function signPasskey(c: Credential, hash: Hex) {
  const signed = await toWebAuthnAccount({
    credential: c,
    rpId: location.hostname,
  }).sign({ hash });
  const json = signed.webauthn.clientDataJSON;
  const prefix = `{"type":"webauthn.get","challenge":"${btoa(
    String.fromCharCode(
      ...new Uint8Array(
        hash
          .slice(2)
          .match(/../g)!
          .map((x) => parseInt(x, 16)),
      ),
    ),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}",`;
  if (!json.startsWith(prefix) || !json.endsWith("}"))
    throw Error("Unsupported WebAuthn client data layout.");
  const fields = json.slice(prefix.length, -1);
  const parsed = JSON.parse(json);
  if (parsed.origin !== location.origin || parsed.crossOrigin === true)
    throw Error("Passkey origin mismatch.");
  const auth = signed.webauthn.authenticatorData;
  if ((parseInt(auth.slice(66, 68), 16) & 5) !== 5)
    throw Error("Passkey did not verify the user.");
  return contractSlot(
    c.signer,
    encodeAbiParameters(
      [
        { type: "bytes" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        auth,
        fields,
        BigInt(sliceHex(signed.signature, 0, 32)),
        BigInt(sliceHex(signed.signature, 32, 64)),
      ],
    ),
  );
}
