const fs = require("node:fs");
const path = require("node:path");
const { keccak256 } = require("viem");
const core = path.resolve(__dirname, "../../../packages/core");
const dependency = (p) => require(path.join(core, "node_modules", p));
const local = (p) => require(path.join(core, "artifacts/contracts", p));
const items = {
  safe: dependency(
    "@safe-global/safe-smart-account/build/artifacts/contracts/Safe.sol/Safe.json",
  ),
  proxy: dependency(
    "@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json",
  ),
  factory: dependency(
    "@safe-global/safe-smart-account/build/artifacts/contracts/proxies/SafeProxyFactory.sol/SafeProxyFactory.json",
  ),
  module: dependency(
    "@safe-global/safe-4337/build/artifacts/contracts/Safe4337Module.sol/Safe4337Module.json",
  ),
  setup: dependency(
    "@safe-global/safe-4337/build/artifacts/contracts/SafeModuleSetup.sol/SafeModuleSetup.json",
  ),
  signerFactory: dependency(
    "@safe-global/safe-passkey/build/artifacts/contracts/SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory.json",
  ),
  createCall: dependency(
    "@safe-global/safe-smart-account/build/artifacts/contracts/libraries/CreateCall.sol/CreateCall.json",
  ),
  router: local("Safe4337RestrictedRouter.sol/Safe4337RestrictedRouter.json"),
  guard: local("TieredSpendingGuard4337.sol/TieredSpendingGuard4337.json"),
  delay: local("test/ZodiacDelayV1_1_1.sol/ZodiacDelayV1_1_1.json"),
  token: local("test/ERC20Mock.sol/ERC20Mock.json"),
};
fs.writeFileSync(
  path.resolve(__dirname, "../src/artifacts.json"),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(items).map(([k, v]) => [
        k,
        {
          abi: v.abi,
          ...(["router", "guard", "delay"].includes(k)
            ? { bytecode: v.bytecode }
            : {}),
          ...(k === "proxy" ? { deployedBytecode: v.deployedBytecode } : {}),
          ...(k === "token"
            ? { runtimeHash: keccak256(v.deployedBytecode) }
            : {}),
        },
      ]),
    ),
  ),
);
