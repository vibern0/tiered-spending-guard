import { concatHex, encodeAbiParameters, getContractAddress, isAddress, keccak256, type Address, type Hex } from "viem";

const MAX_CREATE_NONCE = (1n << 64n) - 1n;

const assertAddress = (value: Address, label: string): void => {
  if (!isAddress(value)) throw new Error(`${label} must be a valid address`);
};

const assertHex = (value: Hex, label: string): void => {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) throw new Error(`${label} must be hex`);
};

const assertCreateNonce = (nonce: bigint): void => {
  if (nonce < 0n || nonce + 3n > MAX_CREATE_NONCE) throw new Error("starting nonce must leave room for four contiguous CREATE deployments");
};

export function deriveComponentAddresses(input: { deployer: Address; startingNonce: bigint }): {
  setupHelper: Address;
  guard: Address;
  delay: Address;
  maintenance: Address;
} {
  assertAddress(input.deployer, "deployer");
  assertCreateNonce(input.startingNonce);
  return {
    setupHelper: getContractAddress({ from: input.deployer, nonce: input.startingNonce }),
    guard: getContractAddress({ from: input.deployer, nonce: input.startingNonce + 1n }),
    delay: getContractAddress({ from: input.deployer, nonce: input.startingNonce + 2n }),
    maintenance: getContractAddress({ from: input.deployer, nonce: input.startingNonce + 3n }),
  };
}

export function deriveSafeProxyAddress(input: {
  factory: Address;
  singleton: Address;
  proxyCreationCode: Hex;
  initializer: Hex;
  saltNonce: bigint;
}): Address {
  assertAddress(input.factory, "factory");
  assertAddress(input.singleton, "singleton");
  assertHex(input.proxyCreationCode, "proxy creation code");
  assertHex(input.initializer, "initializer");
  if (input.proxyCreationCode === "0x") throw new Error("proxy creation code is required");
  if (input.saltNonce < 0n) throw new Error("salt nonce must be non-negative");

  const salt = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [keccak256(input.initializer), input.saltNonce]),
  );
  const bytecode = concatHex([input.proxyCreationCode, encodeAbiParameters([{ type: "address" }], [input.singleton])]);
  return getContractAddress({ opcode: "CREATE2", from: input.factory, salt, bytecode });
}
