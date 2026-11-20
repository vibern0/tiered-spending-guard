// Run against npm run wallet:dev, using an isolated Chromium profile and virtual passkeys.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createPublicClient, http, parseAbi, zeroAddress } from "viem";

const origin =
  "http://localhost:" + (process.env.STATIC_WALLET_UI_PORT || "5180");
const config = await (await fetch(origin + "/local.json")).json();
assert.equal(config.chainId, 31337);
assert.equal(new URL(config.rpcUrl).hostname, "127.0.0.1");
const chain = createPublicClient({ transport: http(config.rpcUrl) });
assert.equal(await chain.getChainId(), 31337);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(20_000);
  const auth = await page.context().newCDPSession(page);
  await auth.send("WebAuthn.enable");
  await auth.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const button = (label) =>
    page.getByRole("button", { name: label, exact: true });
  const visible = (text) => page.getByText(text).first().waitFor();
  // Interrupt final installation after confirmed component preparation. Refresh must resume it.
  let sponsorships = 0;
  await page.route(config.bundlerUrl + "/", async (route) => {
    const request = route.request();
    if (
      request.method() === "POST" &&
      request.postDataJSON().method === "pm_getPaymasterData" &&
      ++sponsorships === 3
    ) {
      const { id } = request.postDataJSON();
      return route.fulfill({
        json: {
          jsonrpc: "2.0",
          id,
          error: { code: -32501, message: "Rehearsal sponsorship declined" },
        },
      });
    }
    return route.continue();
  });

  await page.goto(origin);
  await button("Create wallet").click();
  await visible(/Wallet ready/);
  const activeSafe = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem("static-vault.local.v1")).safe,
    );
  const safe = await activeSafe();
  assert.ok(await chain.getCode({ address: safe }));
  const guardSlot =
    "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
  const moduleGuardSlot =
    "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947";
  const readSlot = async (slot) =>
    "0x" + (await chain.getStorageAt({ address: safe, slot })).slice(-40);
  assert.equal(await readSlot(guardSlot), zeroAddress);
  await page.reload();
  await visible(/Wallet ready/);
  await button("Settings").click();
  await button("Enable protected GLD transfers").click();
  await visible(/Rehearsal sponsorship declined/);
  assert.equal(await readSlot(guardSlot), zeroAddress);
  assert.equal(await readSlot(moduleGuardSlot), zeroAddress);

  await page.reload();
  await visible(/Wallet ready/);
  await button("Settings").click();
  await button("Continue enabling tiered spending").click();
  await visible(/Enabled · verified onchain/);
  await page.reload();
  await visible(/Tiered spending enabled/);
  assert.equal(await activeSafe(), safe);
  await button("Settings").click();
  await visible(/Enabled · verified onchain/);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const guard = await readSlot(guardSlot);
  assert.notEqual(guard, zeroAddress);
  assert.equal(await readSlot(moduleGuardSlot), guard);
  assert.equal(
    await chain.readContract({
      address: guard,
      abi: parseAbi(["function routeOnlyTarget(address) view returns (bool)"]),
      functionName: "routeOnlyTarget",
      args: [config.token],
    }),
    true,
  );
  const tokenBalance = (owner) =>
    chain.readContract({
      address: config.token,
      abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
      functionName: "balanceOf",
      args: [owner],
    });
  const initialBalance = await tokenBalance(safe);
  const destinationBefore = await tokenBalance(config.recipient);
  assert.equal(initialBalance, 100n * 10n ** 18n);
  await button("← Wallet").click();
  for (const amount of ["1", "10"]) {
    await page.getByLabel("Amount (GLD)").fill(amount);
    await button("Send GLD").click();
    await visible(new RegExp("Sent " + amount + " GLD"));
  }
  assert.equal(await tokenBalance(safe), initialBalance - 11n * 10n ** 18n);
  assert.equal(
    await tokenBalance(config.recipient),
    destinationBefore + 11n * 10n ** 18n,
  );
  await page.getByLabel("Amount (GLD)").fill("20");
  await button("Send GLD").click();
  await visible(/needs a delayed withdrawal/);
  assert.equal(await tokenBalance(safe), initialBalance - 11n * 10n ** 18n);
  const operations = await chain.getContractEvents({
    address: config.entryPoint,
    abi: parseAbi([
      "event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)",
    ]),
    eventName: "UserOperationEvent",
    args: { sender: safe },
    fromBlock: 0n,
    toBlock: "latest",
  });
  assert.equal(operations.length, 5);
  assert.ok(
    operations.every(
      ({ args }) =>
        args.success &&
        args.paymaster.toLowerCase() === config.paymaster.toLowerCase(),
    ),
  );
  assert.equal(await chain.getBalance({ address: safe }), 0n);
  console.log(
    "Passed: creation, interrupted installation, same-wallet resume, verified guards, GLD base and step-up transfers, over-limit rejection, sponsored receipts and mobile layout.",
  );
} finally {
  await browser.close();
}
