import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parseAbi, stringToHex, toHex, type Address, type Hex } from "viem";
import { expect } from "vitest";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { encodeP256CosePublicKey } from "./webauthn-fixtures";

// The canonical fixture matches submission-runtime.integration.test.ts; local only.
const coreDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../packages/security-core",
);
const requireCore = createRequire(join(coreDirectory, "package.json"));
export const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
export const RECIPIENT = "0x0000000000000000000000000000000000000a11" as Address;
// Public, ephemeral test payer; never used outside the temporary local chain.
export const PAYER_KEY = `0x${"11".repeat(32)}` as Hex;
export const TOKEN_ABI = parseAbi([
	"function mint(address,uint256)",
	"function balanceOf(address) view returns (uint256)",
]);

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

export async function localChain(directory: string) {
	const port = await unusedPort();
	const configPath = join(directory, "hardhat.config.cjs");
	writeFileSync(
		configPath,
		'module.exports = { networks: { hardhat: { chainId: 11155111, accounts: [], hardfork: "cancun", initialDate: "2026-11-05T12:00:00.000Z", initialBaseFeePerGas: 100000000 } } };\n',
	);
	const child = spawn(
		process.execPath,
		[
			requireCore.resolve("hardhat/internal/cli/bootstrap"),
			"node",
			"--config",
			configPath,
			"--hostname",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{
			cwd: coreDirectory,
			env: { PATH: process.env.PATH, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let errors = "";
	child.stdout?.resume();
	child.stderr?.on("data", (chunk) => {
		errors = `${errors}${chunk}`.slice(-3000);
	});
	const url = `http://127.0.0.1:${port}`;
	let serial = 0;
	const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params }),
		});
		const result = (await response.json()) as { result: T; error?: { message: string } };
		if (result.error) throw new Error(`local ${method}: ${result.error.message}`);
		return result.result;
	};
	for (let attempt = 0; ; attempt++) {
		try {
			if ((await rpc<string>("eth_chainId")) === "0xaa36a7") break;
		} catch {
			/* Wait only for the fresh local test node. */
		}
		if (child.exitCode !== null || attempt > 200) {
			child.kill();
			throw new Error(`local EVM startup failed: ${errors}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return {
		url,
		rpc,
		async close() {
			child.kill("SIGTERM");
			if (child.exitCode === null) await once(child, "exit");
		},
	};
}

export async function installPublicRuntimes(
	rpc: <T>(method: string, params?: unknown[]) => Promise<T>,
) {
	const fixture = JSON.parse(
		readFileSync(
			join(
				coreDirectory,
				"test/fixtures/ordinary-usdc-recycle-continuation-runtimes.public.json",
			),
			"utf8",
		),
	) as { runtimes: Record<Address, { runtimeHash: Hex; bytecode: Hex }> };
	for (const [address, record] of Object.entries(fixture.runtimes)) {
		expect(keccak256(record.bytecode)).toBe(record.runtimeHash);
		await rpc("hardhat_setCode", [address, record.bytecode]);
	}
	// The public capture predates this transitive singleton fixture. Both fixed
	// Sepolia providers returned this exact release-artifact hash on 2026-11-05.
	const signerSingleton = requireCore(
		"@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerSingleton.sol/SafeWebAuthnSignerSingleton.json",
	) as { deployedBytecode: Hex };
	expect(keccak256(signerSingleton.deployedBytecode)).toBe(
		"0x180871920494795a32a7516c60dcc9c4237f435c86681a5d2dd79ea36897d080",
	);
	await rpc("hardhat_setCode", [
		"0x270d7e4a57e6322f336261f3eae2bade72e68d72",
		signerSingleton.deployedBytecode,
	]);
	const multiSend = requireCore(
		"@safe-global/safe-smart-account/build/artifacts/contracts/libraries/MultiSendCallOnly.sol/MultiSendCallOnly.json",
	) as { deployedBytecode: Hex };
	const registry = requireCore(
		"@safe-global/safe-deployments/dist/assets/v1.5.0/multi_send_call_only.json",
	) as { deployments: { canonical: { address: Address; codeHash: Hex } } };
	expect(keccak256(multiSend.deployedBytecode)).toBe(registry.deployments.canonical.codeHash);
	await rpc("hardhat_setCode", [
		registry.deployments.canonical.address,
		multiSend.deployedBytecode,
	]);
	const token = JSON.parse(
		readFileSync(join(coreDirectory, "test/fixtures/sepolia-usdc-runtime.public.json"), "utf8"),
	) as { address: Address; runtimeCodeHash: Hex; bytecode: Hex };
	expect(token.address.toLowerCase()).toBe(TOKEN.toLowerCase());
	expect(keccak256(token.bytecode)).toBe(token.runtimeCodeHash);
	await rpc("hardhat_setCode", [TOKEN, token.bytecode]);

	// Token behavior is a local test double behind the genuine hash-pinned proxy.
	// The custody, guard, signer, Delay, transaction and observer paths stay real.
	const source =
		'pragma solidity ^0.8.24; contract LocalToken { mapping(address=>uint256) public balanceOf; string public constant name="USDC"; string public constant symbol="USDC"; uint8 public constant decimals=6; event Transfer(address indexed from,address indexed to,uint256 value); function mint(address to,uint256 amount) external {balanceOf[to]+=amount; emit Transfer(address(0),to,amount);} function transfer(address to,uint256 amount) external returns(bool){require(balanceOf[msg.sender]>=amount);balanceOf[msg.sender]-=amount;balanceOf[to]+=amount;emit Transfer(msg.sender,to,amount);return true;} }';
	const solc = requireCore("solc") as { compile(input: string): string };
	const compiled = JSON.parse(
		solc.compile(
			JSON.stringify({
				language: "Solidity",
				sources: { "LocalToken.sol": { content: source } },
				settings: {
					evmVersion: "cancun",
					optimizer: { enabled: true, runs: 200 },
					outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } },
				},
			}),
		),
	) as {
		errors?: { severity: string; formattedMessage: string }[];
		contracts: Record<
			string,
			Record<string, { evm: { deployedBytecode: { object: string } } }>
		>;
	};
	expect(compiled.errors?.filter((error) => error.severity === "error") ?? []).toEqual([]);
	const implementation = "0x000000000000000000000000000000000000e001" as Address;
	await rpc("hardhat_setCode", [
		implementation,
		`0x${compiled.contracts["LocalToken.sol"]!["LocalToken"]!.evm.deployedBytecode.object}`,
	]);
	await rpc("hardhat_setStorageAt", [
		TOKEN,
		keccak256(stringToHex("org.zeppelinos.proxy.implementation")),
		toHex(BigInt(implementation), { size: 32 }),
	]);
	await rpc("hardhat_setStorageAt", [
		TOKEN,
		keccak256(stringToHex("org.zeppelinos.proxy.admin")),
		toHex(0xdeadn, { size: 32 }),
	]);
}

/** A software authenticator, never a substitute for browser/hardware UX proof. */
export function softwareAuthenticator(
	role: "primary" | "secondary",
	options: { synced?: boolean } = {},
) {
	const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = createPublicKey(pair.privateKey).export({ format: "jwk" });
	const coordinates = {
		x: BigInt(toHex(Buffer.from(jwk.x!, "base64url"))),
		y: BigInt(toHex(Buffer.from(jwk.y!, "base64url"))),
	};
	const credentialId = randomBytes(32);
	const id = credentialId.toString("base64url");
	let counter = 0;
	const attachment = role === "primary" ? "platform" : "cross-platform";
	const clientData = (type: string, challenge: string, origin: string) =>
		Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	const authenticatorData = (flags: number) => {
		const bytes = Buffer.alloc(4);
		bytes.writeUInt32BE(counter);
		return Buffer.concat([
			createHash("sha256").update("localhost").digest(),
			Buffer.from([flags]),
			bytes,
		]);
	};
	return {
		id,
		coordinates,
		registration(
			challenge: string,
			origin = "http://localhost:5173",
		): RegistrationResponseJSON {
			const length = Buffer.alloc(2);
			length.writeUInt16BE(credentialId.length);
			const authData = Buffer.concat([
				authenticatorData(options.synced ? 0x5d : 0x45),
				Buffer.alloc(16),
				length,
				credentialId,
				encodeP256CosePublicKey(coordinates),
			]);
			const cborLength = Buffer.alloc(3);
			cborLength[0] = 0x59;
			cborLength.writeUInt16BE(authData.length, 1);
			// Canonical CBOR {fmt:"none", attStmt:{}, authData:<bytes>}.
			const attestation = Buffer.concat([
				Buffer.from("a363666d74646e6f6e656761747453746d74a0686175746844617461", "hex"),
				cborLength,
				authData,
			]);
			return {
				id,
				rawId: id,
				type: "public-key",
				authenticatorAttachment: attachment,
				clientExtensionResults: {},
				response: {
					clientDataJSON: clientData("webauthn.create", challenge, origin).toString(
						"base64url",
					),
					attestationObject: attestation.toString("base64url"),
					transports: [role === "primary" ? "internal" : "usb"],
				},
			};
		},
		assertion(challenge: string, origin = "http://localhost:5173"): AuthenticationResponseJSON {
			if (!options.synced) ++counter;
			const data = clientData("webauthn.get", challenge, origin);
			const authData = authenticatorData(options.synced ? 0x1d : 0x05);
			const signature = sign(
				"sha256",
				Buffer.concat([authData, createHash("sha256").update(data).digest()]),
				{ key: pair.privateKey, dsaEncoding: "der" },
			);
			return {
				id,
				rawId: id,
				type: "public-key",
				authenticatorAttachment: attachment,
				response: {
					authenticatorData: authData.toString("base64url"),
					clientDataJSON: data.toString("base64url"),
					signature: signature.toString("base64url"),
				},
				clientExtensionResults: {},
			};
		},
	};
}
