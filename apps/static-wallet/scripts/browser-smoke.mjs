// Run against npm run wallet:dev, using an isolated Chromium profile and virtual passkeys.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import {
  createPublicClient,
  getContractAddress,
  http,
  parseAbi,
  parseUnits,
  zeroAddress,
} from "viem";

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
  // Record browser requests, including unsuccessful attempts. Leave signing to Chromium.
  await page.addInitScript(() => {
    const request = CredentialsContainer.prototype.get;
    window.passkeyRequests = [];
    CredentialsContainer.prototype.get = function (options) {
      if (options?.publicKey) {
        const encode = (bytes) =>
          btoa(String.fromCharCode(...new Uint8Array(bytes)));
        window.passkeyRequests.push({
          credentials: options.publicKey.allowCredentials.map((x) =>
            encode(x.id),
          ),
          challenge: encode(options.publicKey.challenge),
        });
      }
      return request.call(this, options);
    };
  });
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
      (rpc) =>
        JSON.parse(localStorage.getItem("static-vault.local.v1:" + rpc)).safe,
      config.rpcUrl,
    );
  const safe = await activeSafe();
  // Keep recipient balance checks independent of other rehearsals on this local node.
  const recipient = getContractAddress({ from: safe, nonce: 0n });
  // A saved public record from the earlier wallet must survive the network-specific journal migration.
  await page.evaluate((rpc) => {
    const key = "static-vault.local.v1";
    const scoped = key + ":" + rpc;
    localStorage.setItem(key, localStorage.getItem(scoped));
    localStorage.removeItem(scoped);
  }, config.rpcUrl);
  await page.reload();
  await visible(/Wallet ready/);
  assert.equal(await activeSafe(), safe);
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
  await page.getByLabel("Approved GLD recipient").fill(recipient);
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
  const assertions = [];
  auth.on("WebAuthn.credentialAsserted", ({ credential }) => {
    assertions.push(
      Buffer.from(credential.credentialId, "base64").toString("base64url"),
    );
  });
  const ids = await page.evaluate((rpc) => {
    const { primary, secondary } = JSON.parse(
      localStorage.getItem("static-vault.local.v1:" + rpc),
    );
    return [primary.id, secondary.id];
  }, config.rpcUrl);
  assert.notEqual(ids[0], ids[1]);
  const deposit = (account = safe, blockNumber) =>
    chain.readContract({
      address: config.entryPoint,
      abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
      functionName: "balanceOf",
      args: [account],
      blockNumber,
    });
  assert.equal(await deposit(), 0n);
  assert.equal(await chain.getBalance({ address: safe }), 0n);
  const initialBalance = await tokenBalance(safe);
  const destinationBefore = await tokenBalance(recipient);
  assert.equal(initialBalance, 100n * 10n ** 18n);
  await button("← Wallet").click();
  const resetPrompts = async () => {
    assertions.length = 0;
    await page.evaluate(() => {
      window.passkeyRequests.length = 0;
    });
  };
  const checkPrompts = async (label, expectedRoles) => {
    const roles = assertions.map(
      (id) => ["primary", "secondary"][ids.indexOf(id)] ?? "unknown",
    );
    assert.deepEqual(roles, expectedRoles);
    const requests = await page.evaluate(() => window.passkeyRequests);
    assert.equal(requests.length, roles.length);
    assert.equal(new Set(requests.map((r) => r.challenge)).size, 1);
    requests.forEach((r, i) =>
      assert.deepEqual(
        r.credentials.map((id) =>
          Buffer.from(id, "base64").toString("base64url"),
        ),
        [assertions[i]],
      ),
    );
    console.log(
      label + " confirmed on " + safe + " with assertions " + roles.join(", "),
    );
  };
  const instant = parseUnits("10.1", 18);
  for (const [amount, approval, firstMeter, totalMeter] of [
    ["1", "Requires one passkey.", "1 / 10 GLD", "1 / 30 GLD"],
    ["9.1", "Requires both passkeys.", "10 / 10 GLD", "10.1 / 30 GLD"],
  ]) {
    await page.getByLabel("Amount (GLD)").fill(amount);
    await visible(approval);
    await resetPrompts();
    await button("Send GLD").click();
    await visible("Sent " + amount + " GLD");
    await visible(firstMeter);
    await visible(totalMeter);
    await checkPrompts(
      amount + " GLD",
      amount === "1" ? ["primary"] : ["primary", "secondary"],
    );
  }
  assert.equal(await tokenBalance(safe), initialBalance - instant);
  assert.equal(await tokenBalance(recipient), destinationBefore + instant);
  await page.getByLabel("Amount (GLD)").fill("0.1");
  await visible("Requires both passkeys.");
  await page.getByLabel("Amount (GLD)").fill("20");
  await resetPrompts();
  await button("Queue GLD").click();
  await visible(/Queued 20 GLD/);
  await visible(/#0 · 20 GLD/);
  await checkPrompts("Queue 20 GLD", ["primary", "secondary"]);
  assert.ok(await button("Execute withdrawal").isDisabled());
  assert.equal(await tokenBalance(safe), initialBalance - instant);
  await page.reload();
  await visible(/#0 · 20 GLD/);
  await button("Cancel withdrawal").click();
  await visible(/Withdrawal #0 cancelled/);
  await visible(/No pending withdrawals/);
  assert.equal(await tokenBalance(safe), initialBalance - instant);
  await page.getByLabel("Amount (GLD)").fill("20");
  await resetPrompts();
  await button("Queue GLD").click();
  await visible(/#1 · 20 GLD/);
  await checkPrompts("Queue 20 GLD", ["primary", "secondary"]);
  assert.ok(await button("Execute withdrawal").isDisabled());
  await visible("10 / 10 GLD");
  await visible("10.1 / 30 GLD");
  console.log(
    "Cancelled the first withdrawal; waiting for the second onchain cooldown.",
  );
  await button("Execute withdrawal").click({ timeout: 155_000 });
  await visible(/Withdrawal #1 executed/);
  await visible(/No pending withdrawals/);
  assert.equal(
    await tokenBalance(safe),
    initialBalance - (instant + parseUnits("20", 18)),
  );
  assert.equal(
    await tokenBalance(recipient),
    destinationBefore + (instant + parseUnits("20", 18)),
  );
  await visible("10.1 / 30 GLD");
  assert.equal(
    await page
      .getByText("Delayed withdrawals executed")
      .locator("..")
      .locator("dd")
      .innerText(),
    "20 GLD",
  );
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
  assert.equal(await deposit(), 0n);
  assert.equal(operations.length, 9);
  const queued = operations[7];
  const executed = operations[8];
  const queuedAt = (await chain.getBlock({ blockNumber: queued.blockNumber }))
    .timestamp;
  const executedAt = (
    await chain.getBlock({ blockNumber: executed.blockNumber })
  ).timestamp;
  assert.ok(executedAt - queuedAt >= 120n && executedAt - queuedAt <= 720n);
  console.log("Queue to execution (seconds)", String(executedAt - queuedAt));
  for (const event of operations.slice(3)) {
    const before = await deposit(config.paymaster, event.blockNumber - 1n);
    const after = await deposit(config.paymaster, event.blockNumber);
    assert.equal(before - after, event.args.actualGasCost);
    assert.equal(await deposit(safe, event.blockNumber), 0n);
    console.log(
      "Sponsored receipt",
      event.transactionHash,
      "gas cost (wei)",
      String(before - after),
    );
  }
  assert.ok(
    operations.every(
      ({ args }) =>
        args.success &&
        args.actualGasCost > 0n &&
        args.paymaster.toLowerCase() === config.paymaster.toLowerCase(),
    ),
  );
  assert.equal(await chain.getBalance({ address: safe }), 0n);
  console.log(
    "Passed: creation, interrupted installation, same-wallet resume, verified guards, GLD base and step-up transfers, queue recovery, cancellation, timed execution and daily usage, sponsored receipts and mobile layout.",
  );
} finally {
  await browser.close();
}
