import {
  concatHex,
  createPublicClient,
  defineChain,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  formatUnits,
  getContractAddress,
  http,
  hashTypedData,
  toFunctionSelector,
  keccak256,
  padHex,
  parseAbi,
  parseAbiItem,
  size,
  sliceHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import {
  createWebAuthnCredential,
  toPackedUserOperation,
} from "viem/account-abstraction";
import artifacts from "./artifacts.json";
import { providerFields, RpcRejection } from "./provider";
import { X, Y, dailyUsage, transferTier, tokenAmount } from "./transfer";
import { encodeGuardContractSignatures } from "../../../packages/sdk/src/signers/guard-signatures";
import { readQueue, delayedUsage, queueStatus, type Queued } from "./queue";
import { signPasskey } from "./passkey";
import {
  assertLocal,
  parseRecord,
  same,
  policyMatches,
  type Manifest,
  type Credential,
  type WalletRecord,
  type WalletState,
} from "./model";
export {
  KEY,
  parseRecord,
  assertLocal,
  classifyState,
  policyMatches,
  type Manifest,
  type WalletRecord,
  type WalletState,
} from "./model";
import {
  buildSafe4337RouteInstall,
  verifySafe4337RouteTopology,
} from "../../../packages/sdk/src/topology/safe4337-route-install";
import { encodeCallOnlyBatch } from "../../../packages/sdk/src/topology/multisend";

type ArtifactName = keyof typeof artifacts;
const abi = (name: ArtifactName) => artifacts[name].abi as Abi;
const data = (
  name: ArtifactName,
  functionName: string,
  args: readonly unknown[] = [],
) => encodeFunctionData({ abi: abi(name), functionName, args });
const SENTINEL = "0x0000000000000000000000000000000000000001" as Address;
const SLOT = {
  fallback:
    "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
  guard: "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
  moduleGuard:
    "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947",
} as const;
const epAbi = parseAbi([
  "function getNonce(address,uint192) view returns(uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)) view returns(bytes32)",
]);
const executeFullOp = toFunctionSelector(
  "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
);
const transferProofTypes = [{ type: "bytes" }, { type: "bytes" }] as const;
const maxProofBytes = 2048;
const estimateProof: Hex = `0x${"ff".repeat(maxProofBytes)}`;
type TransferApproval = {
  guard: Address;
  requiresSecondary: boolean;
  delayAction?: {
    type: "QueueWithdrawal" | "CancelWithdrawal";
    address: Address;
  };
};
function transferOperation(
  guard: Address,
  token: Address,
  recipient: Address,
  amount: bigint,
  tier: number,
  timestamp: bigint,
  cancelHead?: bigint,
) {
  return concatHex([
    executeFullOp,
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint48" },
      ],
      [guard, token, recipient, amount, tier, Number(timestamp + 300n)],
    ),
    cancelHead === undefined ? "0x" : toHex(cancelHead, { size: 32 }),
  ]);
}

function batch(calls: { to: Address; data: Hex; operation?: 0 | 1 }[]): Hex {
  return concatHex(
    calls.map((c) =>
      concatHex([
        toHex(c.operation ?? 0, { size: 1 }),
        c.to,
        toHex(0, { size: 32 }),
        toHex(size(c.data), { size: 32 }),
        c.data,
      ]),
    ),
  );
}
function rpcJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? toHex(v) : v)),
  );
}
export class Wallet {
  readonly client;
  constructor(
    readonly manifest: Manifest,
    readonly persist: (r: WalletRecord) => void,
    readonly progress: (s: string) => void,
  ) {
    assertLocal(manifest);
    this.client = createPublicClient({
      chain: defineChain({
        id: 31337,
        name: "Disposable research chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [manifest.rpcUrl] } },
      }),
      transport: http(manifest.rpcUrl),
    });
  }
  async rpc(method: string, params: unknown[] = []): Promise<any> {
    const response = await fetch(this.manifest.bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: rpcJson(params),
      }),
    });
    if (!response.ok) throw Error("Local bundler unavailable.");
    const result = await response.json();
    if (result.error)
      throw new RpcRejection(result.error.message, result.error.code);
    return result.result;
  }
  async read(
    name: ArtifactName,
    address: Address,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<any> {
    return this.client.readContract({
      abi: abi(name),
      address,
      functionName,
      args,
    });
  }
  async preflight() {
    if ((await this.client.getChainId()) !== 31337)
      throw Error("RPC chain changed. Refusing to sign.");
    const m = this.manifest;
    if (!same(m.hashes.token, artifacts.token.runtimeHash))
      throw Error(
        "This local chain does not match the reviewed GLD token profile.",
      );
    for (const name of [
      "entryPoint",
      "singleton",
      "proxyFactory",
      "standardModule",
      "moduleSetup",
      "multiSend",
      "multiSendCallOnly",
      "signerFactory",
      "verifier",
      "createCall",
      "paymaster",
      "recipient",
      "token",
    ] as const) {
      const code = await this.client.getCode({ address: m[name] });
      if (!code || code === "0x" || !same(keccak256(code), m.hashes[name]))
        throw Error(`Local ${name} runtime does not match the manifest.`);
    }
    const points = await this.rpc("eth_supportedEntryPoints");
    if (!Array.isArray(points) || !points.some((a) => same(a, m.entryPoint)))
      throw Error("Bundler EntryPoint mismatch.");
  }
  async enroll(label: string): Promise<Credential> {
    this.progress(`Create your ${label} passkey`);
    const c = await createWebAuthnCredential({
      name: `One vault ${label}`,
      rp: { id: location.hostname, name: "One vault — local research" },
      user: {
        id: crypto.getRandomValues(new Uint8Array(32)),
        name: `vault-${crypto.randomUUID()}`,
        displayName: `One vault ${label}`,
      },
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    const signer = await this.read(
      "signerFactory",
      this.manifest.signerFactory,
      "getSigner",
      [
        BigInt(sliceHex(c.publicKey, 0, 32)),
        BigInt(sliceHex(c.publicKey, 32, 64)),
        BigInt(this.manifest.verifier),
      ],
    );
    return { id: c.id, publicKey: c.publicKey, signer };
  }
  signerArgs(c: Credential) {
    return [
      BigInt(sliceHex(c.publicKey, 0, 32)),
      BigInt(sliceHex(c.publicKey, 32, 64)),
      BigInt(this.manifest.verifier),
    ] as const;
  }

  initialization(primary: Credential): Hex {
    const m = this.manifest;
    const setup = batch([
      {
        to: m.signerFactory,
        data: data("signerFactory", "createSigner", this.signerArgs(primary)),
      },
      {
        to: m.moduleSetup,
        data: data("setup", "enableModules", [[m.standardModule]]),
        operation: 1,
      },
    ]);
    return data("safe", "setup", [
      [primary.signer],
      1n,
      m.multiSend,
      encodeFunctionData({
        abi: parseAbi(["function multiSend(bytes)"]),
        functionName: "multiSend",
        args: [setup],
      }),
      m.standardModule,
      zeroAddress,
      0n,
      zeroAddress,
    ]);
  }
  async predict(initializer: Hex, salt: Hex) {
    const m = this.manifest;
    const creation = await this.read(
      "factory",
      m.proxyFactory,
      "proxyCreationCode",
    );
    return getContractAddress({
      opcode: "CREATE2",
      from: m.proxyFactory,
      salt: keccak256(concatHex([keccak256(initializer), salt])),
      bytecode: concatHex([creation, padHex(m.singleton, { size: 32 })]),
    });
  }
  async prepare(): Promise<WalletRecord> {
    await this.preflight();
    const primary = await this.enroll("primary");
    const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const initializer = this.initialization(primary);
    const safe = await this.predict(initializer, salt);
    const record: WalletRecord = {
      version: 1,
      chainId: 31337,
      safe,
      primary,
      salt,
      initializer,
    };
    this.persist(record);
    return record;
  }
  async validateRecord(r: WalletRecord) {
    if (!parseRecord(JSON.stringify(r)))
      throw Error("Invalid saved wallet metadata.");
    const m = this.manifest;
    for (const credential of [
      r.primary,
      ...(r.secondary ? [r.secondary] : []),
    ]) {
      if (
        !same(
          await this.read(
            "signerFactory",
            m.signerFactory,
            "getSigner",
            this.signerArgs(credential),
          ),
          credential.signer,
        )
      )
        throw Error("Saved passkey does not match its factory signer.");
    }
    if (
      r.secondary &&
      (same(r.secondary.signer, r.primary.signer) ||
        r.secondary.id === r.primary.id)
    )
      throw Error("The secondary must be distinct from the primary.");
    const expected = this.initialization(r.primary);
    if (!same(expected, r.initializer))
      throw Error(
        "Saved Safe initialization differs from the reviewed passkey setup.",
      );
    const predicted = await this.predict(expected, r.salt);
    if (!same(predicted, r.safe))
      throw Error("Saved Safe address does not match its initialization.");
  }
  async reconcile(r: WalletRecord) {
    if (!r.pending) return;
    const receipt = await this.rpc("eth_getUserOperationReceipt", [
      r.pending.hash,
    ]);
    if (!receipt)
      throw Error(
        "Submission is still unresolved. Refresh to check its receipt; no duplicate operation will be sent.",
      );
    const hash = r.pending.hash;
    if (
      !same(receipt.userOpHash, hash) ||
      !same(receipt.sender, r.safe) ||
      !same(receipt.paymaster, this.manifest.paymaster) ||
      !same(receipt.entryPoint, this.manifest.entryPoint) ||
      !receipt.receipt?.blockHash
    )
      throw Error("Bundler receipt does not match the pending operation.");
    const events = await this.client.getLogs({
      address: this.manifest.entryPoint,
      blockHash: receipt.receipt.blockHash,
      event: parseAbiItem(
        "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
      ),
      args: {
        userOpHash: hash,
        sender: r.safe,
        paymaster: this.manifest.paymaster,
      },
      strict: true,
    });
    if (
      events.length !== 1 ||
      !same(events[0].transactionHash, receipt.receipt.transactionHash) ||
      events[0].args.success !== receipt.success
    )
      throw Error("No matching EntryPoint event for the reported receipt.");
    delete r.pending;
    this.persist(r);
    if (receipt.success !== true)
      throw Error(
        `The operation reverted (${hash}). Your wallet can be checked and retried.`,
      );
  }
  async submit(
    r: WalletRecord,
    to: Address,
    call: Hex,
    operation: 0 | 1,
    label: string,
    factoryData?: Hex,
    signingModule: Address = this.manifest.standardModule,
    beforeBroadcast?: () => Promise<void>,
  ) {
    return this.submitOperation(
      r,
      data("module", "executeUserOpWithErrorString", [to, 0n, call, operation]),
      label,
      signingModule,
      { factoryData, beforeBroadcast },
    );
  }
  private async submitOperation(
    r: WalletRecord,
    callData: Hex,
    label: string,
    signingModule: Address,
    {
      factoryData,
      beforeBroadcast,
      approval,
    }: {
      factoryData?: Hex;
      beforeBroadcast?: () => Promise<void>;
      approval?: TransferApproval;
    },
  ) {
    await this.preflight();
    await this.validateRecord(r);
    await this.reconcile(r);
    this.progress(`${label} · preparing sponsorship`);
    const m = this.manifest;
    let op: any = {
      sender: r.safe,
      nonce: await this.client.readContract({
        address: m.entryPoint,
        abi: epAbi,
        functionName: "getNonce",
        args: [r.safe, 0n],
      }),
      callData,
      callGasLimit: 11_000_000n,
      verificationGasLimit: 2_500_000n,
      preVerificationGas: 750_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      signature: approval
        ? encodeAbiParameters(transferProofTypes, [
            estimateProof,
            approval.requiresSecondary ? estimateProof : "0x",
          ])
        : toHex(0, { size: 12 }),
      ...(factoryData ? { factory: m.proxyFactory, factoryData } : {}),
    };
    op = {
      ...op,
      ...providerFields(
        await this.rpc("pm_getPaymasterStubData", [
          op,
          m.entryPoint,
          toHex(31337),
          {},
        ]),
        "sponsor",
        m.paymaster,
      ),
    };
    op = {
      ...op,
      ...providerFields(
        await this.rpc("eth_estimateUserOperationGas", [op, m.entryPoint]),
        "gas",
        m.paymaster,
      ),
    };
    op = {
      ...op,
      ...providerFields(
        await this.rpc("pm_getPaymasterData", [
          op,
          m.entryPoint,
          toHex(31337),
          {},
        ]),
        "sponsor",
        m.paymaster,
      ),
    };
    if (
      op.callGasLimit +
        op.verificationGasLimit +
        op.preVerificationGas +
        op.paymasterVerificationGasLimit +
        op.paymasterPostOpGasLimit >
      16_500_000n
    )
      throw Error("Operation exceeds the local sponsored gas budget.");
    this.progress(`${label} · approve with your primary passkey`);
    const hash = await this.client.readContract({
      address: m.entryPoint,
      abi: epAbi,
      functionName: "getUserOpHash",
      args: [toPackedUserOperation(op)],
    });
    if (approval) {
      const domain = {
        name: "GLD Instant Send",
        version: "1",
        chainId: m.chainId,
        verifyingContract: signingModule,
      } as const;
      const fields = [
        { name: "userOpHash", type: "bytes32" },
        { name: "guard", type: "address" },
      ] as const;
      const message = { userOpHash: hash, guard: approval.guard };
      const digest = approval.delayAction
        ? hashTypedData({
            domain,
            primaryType: approval.delayAction.type,
            types: {
              [approval.delayAction.type]: [
                ...fields,
                { name: "delay", type: "address" },
              ],
            },
            message: { ...message, delay: approval.delayAction.address },
          })
        : hashTypedData({
            domain,
            types: {
              InstantSend: fields,
            },
            primaryType: "InstantSend",
            message,
          });
      const primary = await signPasskey(r.primary, digest);
      let secondary: Hex = "0x";
      if (approval.requiresSecondary) {
        if (!r.secondary)
          throw Error("Secondary passkey required for this send.");
        this.progress(label + " · approve with your secondary passkey");
        secondary = sliceHex(await signPasskey(r.secondary, digest), 97);
      }
      if (size(primary) > maxProofBytes || size(secondary) > maxProofBytes)
        throw Error("Passkey proof exceeds the sponsored estimate.");
      op.signature = encodeAbiParameters(transferProofTypes, [
        primary,
        secondary,
      ]);
    } else {
      const digest = await this.read(
        "module",
        signingModule,
        "getOperationHash",
        [toPackedUserOperation(op)],
      );
      op.signature = concatHex([
        toHex(0, { size: 12 }),
        await signPasskey(r.primary, digest),
      ]);
    }
    await this.preflight();
    await beforeBroadcast?.();
    r.pending = { hash, label };
    this.persist(r);
    let returned;
    try {
      returned = await this.rpc("eth_sendUserOperation", [op, m.entryPoint]);
    } catch (error) {
      if (
        error instanceof RpcRejection &&
        [
          -32601, -32602, -32500, -32501, -32502, -32503, -32504, -32505,
          -32506, -32507,
        ].includes(error.code)
      ) {
        delete r.pending;
        this.persist(r);
      }
      throw error;
    }
    if (!same(returned, hash))
      throw Error("Bundler returned an unexpected operation hash.");
    this.progress(`${label} · confirming onchain`);
    for (let n = 0; n < 60; n++) {
      const result = await this.rpc("eth_getUserOperationReceipt", [hash]);
      if (result) {
        await this.reconcile(r);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw Error(
      "Still awaiting inclusion. Refresh to reconcile this operation.",
    );
  }
  async create(r: WalletRecord) {
    await this.validateRecord(r);
    await this.reconcile(r);
    if (await this.client.getCode({ address: r.safe })) return;
    await this.submit(
      r,
      r.safe,
      "0x",
      0,
      "Create wallet",
      data("factory", "createProxyWithNonce", [
        this.manifest.singleton,
        r.initializer,
        BigInt(r.salt),
      ]),
    );
  }
  async inner(
    r: WalletRecord,
    to: Address,
    call: Hex,
    operation: 0 | 1,
    label: string,
    signingModule = this.manifest.standardModule,
    secondary?: Credential,
    beforeBroadcast?: () => Promise<void>,
  ) {
    const nonce = await this.read("safe", r.safe, "nonce");
    const args = [
      to,
      0n,
      call,
      operation,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
    ];
    this.progress(`${label} · approve exact Safe transaction`);
    const digest = await this.read("safe", r.safe, "getTransactionHash", [
      ...args,
      nonce,
    ]);
    let signature = await signPasskey(r.primary, digest);
    if (secondary) {
      this.progress("Approve the same transfer with your secondary passkey");
      const second = await signPasskey(secondary, digest);
      // signPasskey returns the canonical one-contract slot, length and payload.
      signature = encodeGuardContractSignatures(
        { address: r.primary.signer, payload: sliceHex(signature, 97) },
        { address: secondary.signer, payload: sliceHex(second, 97) },
      );
    }
    await this.submit(
      r,
      r.safe,
      data("safe", "execTransaction", [...args, signature]),
      0,
      label,
      undefined,
      signingModule,
      beforeBroadcast,
    );
  }
  async components(r: WalletRecord) {
    const m = this.manifest;
    const salt = keccak256(concatHex([r.salt, padHex(r.safe, { size: 32 })]));
    const deployment = (
      name: "router" | "delay" | "guard",
      args: readonly unknown[],
    ) => {
      const init = encodeDeployData({
        abi: abi(name),
        bytecode: artifacts[name].bytecode as Hex,
        args,
      });
      return {
        init,
        address: getContractAddress({
          opcode: "CREATE2",
          from: m.createCall,
          salt,
          bytecode: init,
        }),
      };
    };
    const router = deployment("router", [
      r.safe,
      m.standardModule,
      m.entryPoint,
      m.token,
      m.paymaster,
    ]);
    const routerRuntime = (await this.client.call({ data: router.init })).data;
    if (!routerRuntime)
      throw Error("Cannot independently derive router runtime.");
    const delay = deployment("delay", [r.safe, r.safe, r.safe, 120n, 600n]);
    const guard = deployment("guard", [
      [r.safe, r.primary.signer, zeroAddress, delay.address, 86400n, 0n],
      keccak256(routerRuntime),
    ]);
    const guardRuntime = (await this.client.call({ data: guard.init })).data;
    const delayRuntime = (await this.client.call({ data: delay.init })).data;
    if (!guardRuntime || !delayRuntime)
      throw Error("Cannot independently derive policy runtimes.");
    return {
      router,
      delay,
      guard,
      salt,
      hashes: {
        router: keccak256(routerRuntime),
        guard: keccak256(guardRuntime),
        delay: keccak256(delayRuntime),
        safe: keccak256(artifacts.proxy.deployedBytecode as Hex),
        standardModule: m.hashes.standardModule,
      },
    };
  }
  async topology(
    r: WalletRecord,
    c: Awaited<ReturnType<Wallet["components"]>>,
    phase: "before" | "after",
  ) {
    return verifySafe4337RouteTopology(
      {
        safe: r.safe,
        primary: r.primary.signer,
        standardModule: this.manifest.standardModule,
        entryPoint: this.manifest.entryPoint,
        multiSendCallOnly: this.manifest.multiSendCallOnly,
        router: c.router.address,
        delay: c.delay.address,
        guard: c.guard.address,
        hashes: c.hashes,
        client: {
          getBytecode: ({ address }) => this.client.getCode({ address }),
          getStorageAt: ({ address, slot }) =>
            this.client.getStorageAt({ address, slot }),
          readContract: (args) => this.client.readContract(args as any),
        },
      },
      phase,
    );
  }
  // The pinned ZodiacCoreCompat fixture stores its linked module list in slot 3.
  async delayUpstream(delay: Address, safe: Address) {
    const next = async (address: Address) => {
      const slot = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          [address, 3n],
        ),
      );
      const word = await this.client.getStorageAt({ address: delay, slot });
      return word ? `0x${word.slice(-40)}` : "";
    };
    return same(await next(SENTINEL), safe) && same(await next(safe), SENTINEL);
  }
  async policy(r: WalletRecord, c: Awaited<ReturnType<Wallet["components"]>>) {
    if (!r.secondary) return false;
    const g = c.guard.address,
      d = c.delay.address;
    const [
      p,
      s,
      e,
      tokens,
      recipients,
      upstream,
      cooldown,
      expiration,
      config,
      frozen,
      maintenance,
      routeTargets,
      routed,
    ] = await Promise.all([
      this.read("guard", g, "assetPolicy", [this.manifest.token]),
      this.read("guard", g, "safeContractSecondary"),
      this.read("guard", g, "ecdsaSecondary"),
      this.read("guard", g, "getConfiguredTokens"),
      this.read("guard", g, "getPolicyRecipients", [this.manifest.token]),
      this.delayUpstream(d, r.safe),
      this.read("delay", d, "txCooldown"),
      this.read("delay", d, "txExpiration"),
      this.read("guard", g, "config"),
      this.read("guard", g, "frozen"),
      this.read("guard", g, "maintenance"),
      this.read("guard", g, "getRouteOnlyTargets"),
      this.read("guard", g, "routeOnlyTarget", [this.manifest.token]),
    ]);
    return (
      policyMatches(p, s, r.secondary.signer) &&
      same(e[0], zeroAddress) &&
      !e[2] &&
      tokens.length === 1 &&
      same(tokens[0], this.manifest.token) &&
      recipients.length === 1 &&
      same(recipients[0], r.recipient ?? this.manifest.recipient) &&
      upstream &&
      cooldown === 120n &&
      expiration === 600n &&
      config[5] === 0n &&
      !frozen &&
      same(maintenance, zeroAddress) &&
      routeTargets.length === 1 &&
      same(routeTargets[0], this.manifest.token) &&
      routed === true
    );
  }
  async inspect(r: WalletRecord): Promise<WalletState> {
    await this.preflight();
    await this.validateRecord(r);
    await this.reconcile(r);
    const code = await this.client.getCode({ address: r.safe });
    if (!code || code === "0x") return "undeployed";
    if (
      !same(keccak256(code), keccak256(artifacts.proxy.deployedBytecode as Hex))
    )
      return "blocked";
    const owners = await this.read("safe", r.safe, "getOwners");
    if (
      owners.length !== 1 ||
      !same(owners[0], r.primary.signer) ||
      (await this.read("safe", r.safe, "getThreshold")) !== 1n
    )
      return "blocked";
    const singleton = await this.client.getStorageAt({
      address: r.safe,
      slot: toHex(0, { size: 32 }),
    });
    if (
      !singleton ||
      !same(`0x${singleton.slice(-40)}`, this.manifest.singleton)
    )
      return "blocked";
    if (
      !same(
        await this.read(
          "signerFactory",
          this.manifest.signerFactory,
          "getSigner",
          this.signerArgs(r.primary),
        ),
        r.primary.signer,
      )
    )
      return "blocked";
    const [modules, next] = await this.read(
      "safe",
      r.safe,
      "getModulesPaginated",
      [SENTINEL, 10n],
    );
    const slots = await Promise.all(
      Object.values(SLOT).map((slot) =>
        this.client.getStorageAt({ address: r.safe, slot }),
      ),
    );
    const values = slots.map((x) => (x ? `0x${x.slice(-40)}` : ""));
    const ordinary =
      modules.length === 1 &&
      same(modules[0], this.manifest.standardModule) &&
      same(next, SENTINEL) &&
      same(values[0], this.manifest.standardModule) &&
      same(values[1], zeroAddress) &&
      same(values[2], zeroAddress);
    if (ordinary) return "ordinary";
    const c = await this.components(r);
    return (await this.topology(r, c, "after")).ok && (await this.policy(r, c))
      ? "enabled"
      : "blocked";
  }
  async tokenBalance(safe: Address) {
    return this.client.readContract({
      address: this.manifest.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [safe],
    });
  }
  async send(
    r: WalletRecord,
    recipient: string,
    text: string,
    reviewedTier?: "base" | "step-up" | "delayed",
  ) {
    if ((await this.inspect(r)) !== "enabled")
      throw Error("Enable protected GLD transfers in Settings first.");
    if (
      !isAddress(recipient) ||
      !same(recipient, r.recipient ?? this.manifest.recipient)
    )
      throw Error("Choose the GLD recipient approved in Settings.");
    const amount = tokenAmount(text);
    if ((await this.tokenBalance(r.safe)) < amount)
      throw Error("Insufficient GLD balance.");
    const components = await this.components(r);
    const [spend, block] = await Promise.all([
      this.read("guard", components.guard.address, "spendState", [
        this.manifest.token,
      ]),
      this.client.getBlock({ blockTag: "pending" }),
    ]);
    const tier = transferTier(amount, dailyUsage(spend, block.timestamp));
    if (reviewedTier && tier !== reviewedTier)
      throw Error("Daily usage changed. Review the updated transfer tier.");
    if (tier !== "base" && !r.secondary)
      throw Error("Secondary passkey is required.");
    const sendData = transferOperation(
      components.guard.address,
      this.manifest.token,
      recipient,
      amount,
      { base: 0, "step-up": 1, delayed: 2 }[tier],
      block.timestamp,
    );
    await this.submitOperation(
      r,
      sendData,
      `${tier === "delayed" ? "Queue" : "Send"} ${formatUnits(amount, 18)} GLD`,
      components.router.address,
      {
        approval: {
          guard: components.guard.address,
          requiresSecondary: tier !== "base",
          delayAction:
            tier === "delayed"
              ? { type: "QueueWithdrawal", address: components.delay.address }
              : undefined,
        },
      },
    );
    return tier;
  }
  async spending(
    r: WalletRecord,
    guard: Address,
    delay: Address,
    blockNumber: bigint,
    now: bigint,
  ) {
    const recipient = r.recipient ?? this.manifest.recipient;
    const [spend, queue, delayed] = await Promise.all([
      this.client.readContract({
        address: guard,
        abi: parseAbi([
          "function spendState(address) view returns(uint256,uint256,uint256)",
        ]),
        functionName: "spendState",
        args: [this.manifest.token],
        blockNumber,
      }),
      readQueue(
        this.client,
        delay,
        this.manifest.token,
        recipient,
        blockNumber,
      ),
      delayedUsage(
        this.client,
        r.safe,
        delay,
        this.manifest.token,
        recipient,
        blockNumber,
        now,
      ),
    ]);
    return { ...dailyUsage(spend, now), queue, delayed };
  }
  async manageWithdrawal(
    r: WalletRecord,
    selected: Queued,
    action: "execute" | "cancel",
  ) {
    if ((await this.inspect(r)) !== "enabled" || !r.secondary)
      throw Error("Verify the protected GLD wallet first.");
    const c = await this.components(r);
    const checkHead = async () => {
      const [block, pending] = await Promise.all([
        this.client.getBlock(),
        this.client.getBlock({ blockTag: "pending" }),
      ]);
      const [head] = await readQueue(
        this.client,
        c.delay.address,
        this.manifest.token,
        r.recipient ?? this.manifest.recipient,
        block.number,
      );
      if (!head || head.nonce !== selected.nonce || head.hash !== selected.hash)
        throw Error("The queue head changed. Refresh the wallet.");
      if (
        action === "execute" &&
        queueStatus(head, pending.timestamp) !== "ready"
      )
        throw Error("The withdrawal is outside its execution window.");
      return head;
    };
    const head = await checkHead();
    const recheck = async () => {
      await checkHead();
    };
    if (action === "cancel") {
      const block = await this.client.getBlock({ blockTag: "pending" });
      await this.submitOperation(
        r,
        transferOperation(
          c.guard.address,
          this.manifest.token,
          head.recipient,
          head.amount,
          3,
          block.timestamp,
          head.nonce,
        ),
        `Cancel withdrawal #${head.nonce} · ${formatUnits(head.amount, 18)} GLD`,
        c.router.address,
        {
          approval: {
            guard: c.guard.address,
            requiresSecondary: true,
            delayAction: { type: "CancelWithdrawal", address: c.delay.address },
          },
          beforeBroadcast: recheck,
        },
      );
    } else {
      await this.submit(
        r,
        c.delay.address,
        data("delay", "executeNextTx", [
          this.manifest.token,
          0n,
          head.calldata,
          0,
        ]),
        0,
        `Execute withdrawal #${head.nonce}`,
        undefined,
        c.router.address,
        recheck,
      );
    }
  }
  async enable(
    r: WalletRecord,
    recipient: string = r.recipient ?? this.manifest.recipient,
  ) {
    await this.preflight();
    const state = await this.inspect(r);
    if (state === "enabled") return;
    if (state !== "ordinary")
      throw Error("This Safe is not eligible for installation.");
    if (
      !isAddress(recipient) ||
      same(recipient, zeroAddress) ||
      same(recipient, r.safe)
    )
      throw Error("Choose a valid recipient different from your Safe.");
    if (r.recipient && !same(r.recipient, recipient))
      throw Error("Continue with the original recipient.");
    r.recipient = recipient;
    this.persist(r);
    if (!r.secondary) {
      r.secondary = await this.enroll("secondary");
      if (
        same(r.secondary.signer, r.primary.signer) ||
        r.secondary.id === r.primary.id
      )
        throw Error("Use a distinct secondary passkey.");
      this.persist(r);
    }
    const c = await this.components(r);
    const m = this.manifest;
    const calls: { to: Address; value: bigint; data: Hex; operation: 0 }[] = [];
    const add = (to: Address, calldata: Hex) =>
      calls.push({ to, value: 0n, data: calldata, operation: 0 });
    for (const item of [c.router, c.delay, c.guard]) {
      const code = await this.client.getCode({ address: item.address });
      if (!code || code === "0x")
        add(
          m.createCall,
          data("createCall", "performCreate2", [0n, item.init, c.salt]),
        );
    }
    if (!(await this.client.getCode({ address: r.secondary.signer })))
      add(
        m.signerFactory,
        data("signerFactory", "createSigner", this.signerArgs(r.secondary)),
      );
    // This batch is atomic; interrupted prerequisite transactions resume from onchain state.
    let prepared = false;
    try {
      prepared =
        (await this.topology(r, c, "before")).ok && (await this.policy(r, c));
    } catch {
      /* undeployed components */
    }
    if (!prepared) {
      add(
        c.guard.address,
        data("guard", "configureAaRouter", [c.router.address]),
      );
      add(
        c.guard.address,
        data("guard", "setAssetPolicy", [m.token, X, Y, X, Y, [r.recipient]]),
      );
      add(c.guard.address, data("guard", "addRouteOnlyTarget", [m.token]));
      add(
        c.guard.address,
        data("guard", "configureSafeContractSecondary", [
          r.secondary.signer,
          true,
        ]),
      );
      add(c.delay.address, data("delay", "enableModule", [r.safe]));
      const calldata = encodeFunctionData({
        abi: parseAbi(["function multiSend(bytes)"]),
        functionName: "multiSend",
        args: [encodeCallOnlyBatch(calls)],
      });
      await this.inner(
        r,
        m.multiSendCallOnly,
        calldata,
        1,
        "Prepare tiered spending",
      );
    }
    const before = await this.topology(r, c, "before");
    if (!before.ok || !(await this.policy(r, c)))
      throw Error(
        `Installation prerequisites mismatch: ${before.failures.join(", ")}`,
      );
    const install = buildSafe4337RouteInstall({
      safe: r.safe,
      standardModule: m.standardModule,
      router: c.router.address,
      delay: c.delay.address,
      guard: c.guard.address,
      multiSendCallOnly: m.multiSendCallOnly,
    });
    await this.inner(
      r,
      install.to,
      install.data,
      install.operation,
      "Enable tiered spending",
    );
    if ((await this.inspect(r)) !== "enabled")
      throw Error(
        "Installation receipt arrived, but policy verification failed.",
      );
  }
}
