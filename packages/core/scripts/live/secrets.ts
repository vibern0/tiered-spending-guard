import { createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AutomatedCredential } from "./webauthn";

function externalPath(path: string, repository: string): string {
  if (!isAbsolute(path)) throw new Error("absolute path required");
  const parent = realpathSync(dirname(path));
  const target = join(parent, basename(path));
  const rel = relative(realpathSync(repository), target);
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) throw new Error("outside repository required");
  const info = statSync(parent);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error("private directory required");
  // Sticky public ancestors protect owned children; other writable ancestors do not.
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    const node = statSync(ancestor);
    if (!node.isDirectory() || (node.uid !== 0 && node.uid !== process.getuid?.()) || ((node.mode & 0o022) !== 0 && (node.mode & 0o1000) === 0)) throw new Error("untrusted ancestor");
    if (dirname(ancestor) === ancestor) break;
  }
  return target;
}

function readSecret(path: string, repository: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(externalPath(path, repository), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384) throw new Error("invalid secret file");
    return readFileSync(fd, "utf8");
  } catch { throw new Error("secret file rejected: require a private external regular file"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function validateCredential(credential: AutomatedCredential): AutomatedCredential {
  const pub = createPublicKey(createPrivateKey(credential.privateKeyPem)).export({ format: "jwk" });
  if (pub.crv !== "P-256" || !pub.x || !pub.y || BigInt(toHex(Buffer.from(pub.x, "base64url"))) !== credential.x || BigInt(toHex(Buffer.from(pub.y, "base64url"))) !== credential.y) throw new Error("invalid credential");
  return credential;
}

export function loadFundingKey(path: string, repository: string): Hex {
  const raw = readSecret(path, repository).trim();
  try {
    if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error("invalid key");
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    privateKeyToAccount(key);
    return key;
  } catch { throw new Error("funding key rejected"); }
}

export function saveCredential(path: string, repository: string, credential: AutomatedCredential): void {
  let fd: number | undefined;
  try {
    validateCredential(credential);
    const target = externalPath(path, repository);
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, JSON.stringify({ privateKeyPem: credential.privateKeyPem, x: credential.x.toString(), y: credential.y.toString() }) + "\n");
    fsyncSync(fd);
    const directoryFd = openSync(dirname(target), constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch { throw new Error("credential persistence failed; existing identities are never overwritten"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function loadCredential(path: string, repository: string): AutomatedCredential {
  const raw = readSecret(path, repository);
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.privateKeyPem !== "string" || typeof value.x !== "string" || typeof value.y !== "string" || !/^[0-9]{1,78}$/.test(value.x) || !/^[0-9]{1,78}$/.test(value.y)) throw new Error("invalid credential");
    return validateCredential({ privateKeyPem: value.privateKeyPem, x: BigInt(value.x), y: BigInt(value.y) });
  } catch { throw new Error("credential rejected"); }
}
