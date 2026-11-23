// Disposable chain and ERC-4337 RPC for the static wallet's local rehearsal.
const hre = require("hardhat");
const { createServer } = require("node:http");
const { mkdir, writeFile, rename } = require("node:fs/promises");
const path = require("node:path");
const {
  concatHex,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  toHex,
} = require("viem");
const { toPackedUserOperation } = require("viem/account-abstraction");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");
const entryArtifact = require("@account-abstraction/contracts/artifacts/EntryPoint.json");
const payerArtifact = require("@account-abstraction/contracts/artifacts/VerifyingPaymaster.json");
const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const port = Number(process.env.STATIC_WALLET_RPC_PORT || 8547);
const fundedSafe = "0x614f2F5011b9C329770576be59Ae294a6e7D9fdC";
const tokenUnit = 10n ** 18n;
const rpcUrl = "http://127.0.0.1:" + port;
const safe = (name) =>
  require(
    "@safe-global/safe-smart-account/build/artifacts/contracts/" +
      name +
      ".json",
  );
const aa = (name) =>
  require("@safe-global/safe-4337/build/artifacts/contracts/" + name + ".json");
const passkey = (name) =>
  require(
    "@safe-global/safe-passkey/build/artifacts/contracts/" + name + ".json",
  );
const artifacts = {
  singleton: safe("Safe.sol/Safe"),
  proxyFactory: safe("proxies/SafeProxyFactory.sol/SafeProxyFactory"),
  moduleSetup: aa("SafeModuleSetup.sol/SafeModuleSetup"),
  standardModule: aa("Safe4337Module.sol/Safe4337Module"),
  multiSend: safe("libraries/MultiSend.sol/MultiSend"),
  multiSendCallOnly: safe("libraries/MultiSendCallOnly.sol/MultiSendCallOnly"),
  createCall: safe("libraries/CreateCall.sol/CreateCall"),
  signerFactory: passkey(
    "SafeWebAuthnSignerFactory.sol/SafeWebAuthnSignerFactory",
  ),
  verifier: passkey("verifiers/FCLP256Verifier.sol/FCLP256Verifier"),
  recipient: safe("test/TestNativeTokenReceiver.sol/TestNativeTokenReceiver"),
};

async function main() {
  const rpc = (method, params = []) =>
    hre.network.provider.send(method, params);
  if (hre.network.name !== "hardhat" || (await rpc("eth_chainId")) !== "0x7a69")
    throw Error("Requires a disposable local Hardhat chain");
  if (process.argv.includes("--e2e")) {
    // Anchor the test at UTC noon so the real cooldown cannot cross a daily reset.
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(12, 0, 0, 0);
    await rpc("evm_setNextBlockTimestamp", [tomorrow.getTime() / 1000]);
  }
  const [wallet] = await hre.viem.getWalletClients();
  const client = await hre.viem.getPublicClient();
  async function deploy(artifact, args = []) {
    const hash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw Error("Fixture deployment failed");
    return receipt.contractAddress;
  }
  const deployed = await deploy(entryArtifact);
  // The route pins the published module runtime, including its canonical EntryPoint immutable.
  // Keep the deployed SenderCreator referenced by this runtime in the same local chain.
  await rpc("hardhat_setCode", [
    EP,
    await client.getCode({ address: deployed }),
  ]);
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const manifest = {
    chainId: 31337,
    rpcUrl,
    bundlerUrl: rpcUrl,
    entryPoint: EP,
    hashes: {},
  };
  for (const [name, artifact] of Object.entries(artifacts)) {
    manifest[name] = await deploy(
      artifact,
      name === "standardModule" ? [EP] : [],
    );
  }
  manifest.paymaster = await deploy(payerArtifact, [EP, sponsor.address]);
  const deposit = await wallet.writeContract({
    address: EP,
    abi: entryArtifact.abi,
    functionName: "depositTo",
    args: [manifest.paymaster],
    value: 5n * 10n ** 18n,
  });
  await client.waitForTransactionReceipt({ hash: deposit });
  for (const name of ["entryPoint", ...Object.keys(artifacts), "paymaster"]) {
    manifest.hashes[name] = keccak256(
      await client.getCode({ address: manifest[name] }),
    );
  }
  const tokenArtifact = await hre.artifacts.readArtifact("ERC20Mock");
  manifest.token = await deploy(tokenArtifact, [
    wallet.account.address,
    1_000_000n * tokenUnit,
  ]);
  manifest.hashes.token = keccak256(
    await client.getCode({ address: manifest.token }),
  );
  async function fundDemoSafe(address, amount) {
    const tx = await wallet.writeContract({
      address: manifest.token,
      abi: tokenArtifact.abi,
      functionName: "transfer",
      args: [address, amount * tokenUnit],
    });
    if (
      (await client.waitForTransactionReceipt({ hash: tx })).status !==
      "success"
    )
      throw Error("Local GLD funding failed");
  }
  await fundDemoSafe(fundedSafe, 1000n);
  const entry = { address: EP, abi: entryArtifact.abi };
  const gas = {
    preVerificationGas: toHex(750000n),
    verificationGasLimit: toHex(2500000n),
    callGasLimit: toHex(11000000n),
  };
  const pmGas = {
    paymasterVerificationGasLimit: toHex(150000n),
    paymasterPostOpGasLimit: "0x0",
  };
  const receipts = new Map();
  const readMethods = new Set([
    "eth_chainId",
    "eth_getCode",
    "eth_getStorageAt",
    "eth_call",
    "eth_getBlockByNumber",
    "eth_getBlockByHash",
    "eth_getBalance",
    "eth_getTransactionCount",
    "eth_getTransactionReceipt",
    "eth_getTransactionByHash",
    "eth_getLogs",
    "eth_blockNumber",
    "eth_gasPrice",
    "eth_estimateGas",
    "eth_maxPriorityFeePerGas",
    "eth_feeHistory",
  ]);
  function packed(op) {
    const fields = { signature: "0x", ...op };
    for (const name of [
      "nonce",
      "preVerificationGas",
      "verificationGasLimit",
      "callGasLimit",
      "maxPriorityFeePerGas",
      "maxFeePerGas",
      "paymasterVerificationGasLimit",
      "paymasterPostOpGasLimit",
    ]) {
      if (fields[name] !== undefined) fields[name] = BigInt(fields[name]);
    }
    return toPackedUserOperation(fields);
  }
  async function dispatch(method, params) {
    if (readMethods.has(method)) return rpc(method, params);
    if (method === "eth_supportedEntryPoints") return [EP];
    const [op, ep] = params;
    if (method === "eth_getUserOperationReceipt")
      return receipts.get(op) ?? null;
    if (ep?.toLowerCase() !== EP.toLowerCase())
      throw Error("Unsupported EntryPoint");
    if (method === "eth_estimateUserOperationGas") return { ...gas, ...pmGas };
    if (
      method === "pm_getPaymasterData" ||
      method === "pm_getPaymasterStubData"
    ) {
      if (BigInt(params[2]) !== 31337n) throw Error("Unsupported chain");
      const result = { paymaster: manifest.paymaster, ...pmGas };
      const validity = encodeAbiParameters(
        [{ type: "uint48" }, { type: "uint48" }],
        [0, 0],
      );
      const stub = concatHex([validity, "0x" + "00".repeat(65)]);
      if (method === "pm_getPaymasterStubData")
        return { ...result, paymasterData: stub };
      const digest = await client.readContract({
        address: manifest.paymaster,
        abi: payerArtifact.abi,
        functionName: "getHash",
        args: [packed({ ...op, ...result, paymasterData: stub }), 0, 0],
      });
      return {
        ...result,
        paymasterData: concatHex([
          validity,
          await sponsor.signMessage({ message: { raw: digest } }),
        ]),
      };
    }
    if (method !== "eth_sendUserOperation") throw Error("Unsupported method");
    if (op.paymaster?.toLowerCase() !== manifest.paymaster.toLowerCase())
      throw Error("Local sponsorship required");
    const operation = packed(op);
    const hash = await client.readContract({
      ...entry,
      functionName: "getUserOpHash",
      args: [operation],
    });
    if (receipts.has(hash)) return hash;
    const tx = {
      ...entry,
      functionName: "handleOps",
      args: [[operation], wallet.account.address],
      account: wallet.account,
      gas: 16500000n,
    };
    try {
      await client.simulateContract(tx);
    } catch {
      throw Object.assign(
        new Error("EntryPoint declined the operation before submission."),
        { rpcCode: -32500 },
      );
    }
    const txHash = await wallet.writeContract(tx);
    const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
    for (const log of receipt.logs.filter(
      (log) => log.address.toLowerCase() === EP.toLowerCase(),
    )) {
      let event;
      try {
        event = decodeEventLog({
          abi: entryArtifact.abi,
          data: log.data,
          topics: log.topics,
        });
      } catch {
        continue;
      }
      if (
        event.eventName !== "UserOperationEvent" ||
        event.args.userOpHash !== hash
      )
        continue;
      const {
        sender,
        nonce,
        paymaster,
        success,
        actualGasCost,
        actualGasUsed,
      } = event.args;
      receipts.set(hash, {
        userOpHash: hash,
        entryPoint: EP,
        sender,
        nonce: toHex(nonce),
        paymaster,
        success,
        actualGasCost: toHex(actualGasCost),
        actualGasUsed: toHex(actualGasUsed),
        logs: receipt.logs,
        receipt,
      });
      // Give newly created demo Safes a test balance once. The named Safe is already seeded.
      if (
        success &&
        op.factory?.toLowerCase() === manifest.proxyFactory.toLowerCase() &&
        sender.toLowerCase() !== fundedSafe.toLowerCase()
      )
        await fundDemoSafe(sender, 100n);
      return hash;
    }
    throw Error("Missing EntryPoint receipt");
  }
  const server = createServer(async (req, res) => {
    // Only loopback wallet frontends may use this disposable sponsor and local chain.
    const origin = req.headers.origin;
    if (
      req.headers.host !== "127.0.0.1:" + port ||
      (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    ) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin ?? rpcUrl);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    let id = null;
    try {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 524288) throw Error("Request too large");
      }
      const request = JSON.parse(data);
      id = request.id;
      const result = await dispatch(request.method, request.params ?? []);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (err) {
      // Avoid echoing raw signed operations in responses or terminal logs.
      const message =
        (err.rpcCode && err.message) ||
        err.walk?.((cause) => cause.reason)?.reason ||
        err.shortMessage?.split("\n")[0] ||
        "Local RPC rejected the request";
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: err.rpcCode ?? -32000, message },
        }),
      );
    }
  });
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(port, "127.0.0.1", resolve),
  );
  const root = path.resolve(__dirname, "../../../../apps/static-wallet");
  const directory =
    process.env.STATIC_WALLET_PUBLIC_DIR || path.join(root, "public");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "local.json");
  await writeFile(file + ".tmp", JSON.stringify(manifest, null, 2) + "\n");
  await rename(file + ".tmp", file);
  console.log(
    "Disposable local chain, bundler and paymaster ready at " + rpcUrl,
  );
  if (process.argv.includes("--wallet")) {
    const vite = await import(
      require("node:module")
        .createRequire(path.join(root, "package.json"))
        .resolve("vite")
    );
    const frontend = await vite.createServer({
      root,
      publicDir: directory,
      server: {
        host: "localhost",
        port: Number(process.env.STATIC_WALLET_UI_PORT || 5180),
        strictPort: true,
      },
    });
    await frontend.listen();
    frontend.printUrls();
  }
}
main().catch((err) => {
  console.error(err.shortMessage ?? err.message);
  process.exit(1);
});
