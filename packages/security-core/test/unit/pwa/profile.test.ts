import { expect } from "chai";
import { readFileSync } from "node:fs";
import { keccak256, type Address, type Hex } from "viem";
import {
  captureUsdcIdentity,
  loadCommittedPwaPhaseOneProfile,
  loadPwaPhaseOneProfile,
  REVIEWED_USDC_RUNTIME_CODE_HASH,
  SEPOLIA_USDC_ADDRESS,
  type UsdcIdentityClient,
} from "../../../src/pwa/profile";

const BLOCK_HASH = `0x${"ab".repeat(32)}` as Hex;
const CODE = "0x6001" as Hex;
const RECIPIENT = "0xaD4D5cd2Ec5beCdB9608baD4c36F0dBe8b2492Bc" as Address;

const profileInput = () => ({
  formatVersion: 1,
  chainId: 11155111,
  token: SEPOLIA_USDC_ADDRESS,
  runtimeCodeHash: REVIEWED_USDC_RUNTIME_CODE_HASH,
  name: "USDC",
  symbol: "USDC",
  decimals: 6,
  secondaryProfile: "contract-only",
  periodSeconds: 86400,
  periodAnchor: "0",
  limits: {
    basePerTransaction: "1000000",
    baseDailyLimit: "1000000",
    stepUpPerTransaction: "3000000",
    instantDailyLimit: "3000000",
  },
  delay: { cooldownSeconds: 120, expirationSeconds: 600 },
  recipient: RECIPIENT,
  amounts: { base: "1000000", stepUp: "2000000", delayed: "4000000", funding: "8000000" },
  identityReview: {
    blockNumber: "12034092",
    blockHash: "0x5db4ca50de5c2411433fe8ed34a2eb940de48b9607afb97bf6aa962749b68501",
    confirmations: 6,
    providers: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"],
  },
});

const mutate = (change: (value: ReturnType<typeof profileInput>) => void) => {
  const value = profileInput();
  change(value);
  return value;
};

describe("Sepolia PWA Phase One profile", () => {
  it("exposes the reviewed repository profile without operator input", () => {
    expect(loadCommittedPwaPhaseOneProfile()).to.deep.equal(loadPwaPhaseOneProfile(profileInput()));
  });

  it("loads the committed canonical profile artifact", () => {
    const profile = loadPwaPhaseOneProfile(JSON.parse(readFileSync("config/sepolia.pwa-phase-one.json", "utf8")));

    expect(profile.token).to.equal(SEPOLIA_USDC_ADDRESS);
    expect(profile.identityReview.blockNumber).to.equal(12_034_092n);
  });

  it("loads the exact contract-only USDC policy using bigint amounts", () => {
    const profile = loadPwaPhaseOneProfile(profileInput());

    expect(profile).to.include({ chainId: 11155111, name: "USDC", symbol: "USDC", decimals: 6, secondaryProfile: "contract-only" });
    expect(profile.token).to.equal(SEPOLIA_USDC_ADDRESS);
    expect(profile.runtimeCodeHash).to.equal(REVIEWED_USDC_RUNTIME_CODE_HASH);
    expect(profile.limits).to.deep.equal({ basePerTransaction: 1_000_000n, baseDailyLimit: 1_000_000n, stepUpPerTransaction: 3_000_000n, instantDailyLimit: 3_000_000n });
    expect(profile.delay).to.deep.equal({ cooldownSeconds: 120, expirationSeconds: 600 });
    expect(profile.amounts).to.deep.equal({ base: 1_000_000n, stepUp: 2_000_000n, delayed: 4_000_000n, funding: 8_000_000n });
    expect(profile.periodAnchor).to.equal(0n);
    expect(profile.recipient).to.equal(RECIPIENT);
  });

  it("rejects unknown fields at every profile boundary", () => {
    expect(() => loadPwaPhaseOneProfile({ ...profileInput(), browserToken: SEPOLIA_USDC_ADDRESS })).to.throw("unknown profile field");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => Object.assign(value.limits, { extra: "1" })))).to.throw("unknown limits field");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => Object.assign(value.identityReview, { rpcResponse: "trusted" })))).to.throw("unknown identityReview field");
  });

  it("rejects wrong token identity, metadata, runtime hash, and recipient", () => {
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.token = RECIPIENT; }))).to.throw("token");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.runtimeCodeHash = `0x${"00".repeat(32)}`; }))).to.throw("runtime code hash");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.identityReview.blockHash = `0x${"00".repeat(32)}`; }))).to.throw("two-provider artifact");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.name = "USD Coin"; }))).to.throw("metadata");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.symbol = "EURC"; }))).to.throw("metadata");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.decimals = 18; }))).to.throw("metadata");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.recipient = SEPOLIA_USDC_ADDRESS; }))).to.throw("recipient");
  });

  it("rejects floats, negative and noncanonical decimal strings", () => {
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { (value.limits.basePerTransaction as unknown) = 1.5; }))).to.throw("canonical decimal string");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.amounts.delayed = "-4000000"; }))).to.throw("canonical decimal string");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.amounts.funding = "08000000"; }))).to.throw("canonical decimal string");
  });

  it("rejects policy drift and any non-contract-only mode", () => {
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.limits.baseDailyLimit = "2000000"; }))).to.throw("canonical X limits");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.limits.instantDailyLimit = "4000000"; }))).to.throw("canonical Y limits");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.periodAnchor = "1"; }))).to.throw("epoch-aligned");
    expect(() => loadPwaPhaseOneProfile(mutate((value) => { value.secondaryProfile = "dual"; }))).to.throw("contract-only");
  });
});

const identityClient = (source: string, overrides: Partial<UsdcIdentityClient> = {}): UsdcIdentityClient => ({
  source,
  getChainId: async () => 11155111,
  getBlockNumber: async () => 105n,
  getBlock: async () => ({ number: 100n, hash: BLOCK_HASH }),
  getCode: async () => CODE,
  readContract: async ({ functionName }) => functionName === "name" || functionName === "symbol" ? "USDC" : 6,
  ...overrides,
});

describe("reviewed USDC identity capture", () => {
  it("requires two providers to agree at one six-confirmation block", async () => {
    const reviewed = await captureUsdcIdentity(
      identityClient("https://provider-a.example"),
      identityClient("https://provider-b.example"),
      100n,
    );

    expect(reviewed).to.deep.include({ chainId: 11155111, token: SEPOLIA_USDC_ADDRESS, blockNumber: 100n, blockHash: BLOCK_HASH, confirmations: 6, runtimeCodeHash: keccak256(CODE), name: "USDC", symbol: "USDC", decimals: 6 });
    expect(reviewed.providers).to.deep.equal(["https://provider-a.example", "https://provider-b.example"]);
  });

  it("rejects provider disagreement, insufficient confirmations, and reorgs", async () => {
    const differentHash = `0x${"cd".repeat(32)}` as Hex;
    await expect(captureUsdcIdentity(identityClient("https://a.example"), identityClient("https://b.example", { getBlock: async () => ({ number: 100n, hash: differentHash }) }), 100n)).to.be.rejectedWith("block hash disagreement");
    await expect(captureUsdcIdentity(identityClient("https://a.example", { getBlockNumber: async () => 104n }), identityClient("https://b.example"), 100n)).to.be.rejectedWith("six confirmations");
    let calls = 0;
    await expect(captureUsdcIdentity(identityClient("https://a.example", { getBlock: async () => ({ number: 100n, hash: ++calls === 1 ? BLOCK_HASH : differentHash }) }), identityClient("https://b.example"), 100n)).to.be.rejectedWith("reorg");
  });
});
