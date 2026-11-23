import { test, expect } from "@playwright/test";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
} from "viem";

// Record the browser request as well as Chromium's successful credential assertion.
// Two successful signatures alone would miss an extra prompt that failed or was retried.
async function virtualPasskeys(page) {
  await page.addInitScript(() => {
    const get = CredentialsContainer.prototype.get;
    window.passkeyRequests = [];
    const base64 = (bytes) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)));
    CredentialsContainer.prototype.get = function (options) {
      if (options?.publicKey) {
        window.passkeyRequests.push({
          ids: options.publicKey.allowCredentials.map((entry) =>
            base64(entry.id),
          ),
          challenge: base64(options.publicKey.challenge),
        });
      }
      return get.call(this, options);
    };
  });
  const session = await page.context().newCDPSession(page);
  const enrolled = [];
  const asserted = [];
  session.on("WebAuthn.credentialAdded", ({ credential }) =>
    enrolled.push(credential.credentialId),
  );
  session.on("WebAuthn.credentialAsserted", ({ credential }) =>
    asserted.push(credential.credentialId),
  );
  await session.send("WebAuthn.enable");
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    enrolled,
    async confirm(ids, action) {
      asserted.length = 0;
      await page.evaluate(() => {
        window.passkeyRequests.length = 0;
      });
      await action();
      const requests = await page.evaluate(() => window.passkeyRequests);
      expect(requests.map((r) => r.ids)).toEqual(ids.map((id) => [id]));
      expect(new Set(requests.map((r) => r.challenge)).size).toBe(1);
      expect(asserted).toEqual(ids);
    },
  };
}

test("create a Safe, enable protection, spend, queue, cancel and execute with sponsored gas", async ({
  page,
  request,
}) => {
  const response = await request.get("/local.json");
  expect(response.ok()).toBe(true);
  const config = await response.json();
  expect(config.rpcUrl).toBe("http://127.0.0.1:18547");
  expect(config.bundlerUrl).toBe(config.rpcUrl);
  const chain = createPublicClient({ transport: http(config.rpcUrl) });
  expect(await chain.getChainId()).toBe(31337);
  const keys = await virtualPasskeys(page);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const amount = page.getByLabel("Amount (GLD)");
  const queue = page.getByRole("region", { name: "Withdrawal queue" });
  const entry = (n) =>
    queue.getByRole("article").filter({ hasText: `#${n} · 20 GLD` });
  const tokenBalance = (owner) =>
    chain.readContract({
      address: config.token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
  const recipient = getAddress(config.recipient);
  const startingRecipientBalance = await tokenBalance(recipient);
  let safe;
  const balance = async (inSafe, received) => {
    expect(await tokenBalance(safe)).toBe(parseEther(inSafe));
    expect(await tokenBalance(recipient)).toBe(
      startingRecipientBalance + parseEther(received),
    );
  };
  const guardSlots = () =>
    Promise.all(
      [
        "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
        "0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947",
      ].map(async (slot) =>
        getAddress(
          "0x" + (await chain.getStorageAt({ address: safe, slot })).slice(-40),
        ),
      ),
    );

  await test.step("Create and fund an ordinary passkey Safe", async () => {
    await page.goto("/");
    await button("Create wallet").click();
    await expect(
      page.getByText(/Wallet ready · tiered spending is off/),
    ).toBeVisible();
    await expect(page.getByText("100 GLD", { exact: true })).toBeVisible();
    safe = getAddress(await page.locator("p.address").innerText());
    expect(await chain.getCode({ address: safe })).toMatch(/^0x[0-9a-f]+$/i);
    expect(await guardSlots()).toEqual([zeroAddress, zeroAddress]);
    expect(keys.enrolled).toHaveLength(1);
    await balance("100", "0");
  });
  await test.step("Enroll the secondary and enable the same guard in both Safe slots", async () => {
    await button("Settings").click();
    await page.getByLabel("Approved GLD recipient").fill(recipient);
    await button("Enable protected GLD transfers").click();
    await expect(page.getByText(/Enabled · verified onchain/)).toBeVisible();
    const [transactionGuard, moduleGuard] = await guardSlots();
    expect(transactionGuard).not.toBe(zeroAddress);
    expect(moduleGuard).toBe(transactionGuard);
    expect(keys.enrolled).toHaveLength(2);
    expect(keys.enrolled[0]).not.toBe(keys.enrolled[1]);
    await button("← Wallet").click();
    await expect(page.getByText(safe, { exact: true })).toBeVisible();
  });
  const [primary, secondary] = keys.enrolled;
  for (const [value, ids, baseUsed, totalUsed] of [
    ["1", [primary], "1", "1"],
    ["9.1", [primary, secondary], "10", "10.1"],
  ]) {
    await test.step(`Send ${value} GLD with ${ids.length} passkey approval(s)`, async () => {
      await amount.fill(value);
      await keys.confirm(ids, async () => {
        await button("Send GLD").click();
        await expect(
          page.getByText(`Sent ${value} GLD to`, { exact: false }),
        ).toBeVisible();
      });
      await expect(
        page.getByText(`${baseUsed} / 10 GLD`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(`${totalUsed} / 30 GLD`, { exact: true }),
      ).toBeVisible();
    });
  }
  for (const n of [0, 1]) {
    await test.step(`Queue the full 20 GLD as withdrawal #${n} with both passkeys`, async () => {
      await amount.fill("20");
      await keys.confirm([primary, secondary], async () => {
        await button("Queue GLD").click();
        await expect(entry(n)).toBeVisible();
      });
      await balance("89.9", "10.1");
    });
  }
  await test.step("Reload and cancel only the oldest withdrawal with both passkeys", async () => {
    await page.reload();
    await expect(
      entry(0).getByRole("button", { name: "Execute withdrawal" }),
    ).toBeDisabled();
    await keys.confirm([primary, secondary], async () => {
      await entry(0).getByRole("button", { name: "Cancel withdrawal" }).click();
      await expect(
        page.getByText("Withdrawal #0 cancelled.", { exact: true }),
      ).toBeVisible();
    });
    await expect(entry(0)).toHaveCount(0);
    await expect(entry(1)).toBeVisible();
    await balance("89.9", "10.1");
  });
  await test.step("Execute the surviving withdrawal after its 120-second cooldown", async () => {
    const execute = entry(1).getByRole("button", {
      name: "Execute withdrawal",
    });
    await expect(execute).toBeDisabled();
    await expect(execute).toBeEnabled({ timeout: 155_000 });
    await keys.confirm([primary], async () => {
      await execute.click();
      await expect(
        page.getByText("Withdrawal #1 executed.", { exact: true }),
      ).toBeVisible();
    });
    await expect(queue.getByText("No pending withdrawals.")).toBeVisible();
    await expect(
      page.getByText("10.1 / 30 GLD", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByText("Delayed withdrawals executed")
        .locator("..")
        .locator("dd"),
    ).toHaveText("20 GLD");
    await balance("69.9", "30.1");
  });
  await test.step("Verify cooldown and sponsorship against EntryPoint receipts", async () => {
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
    // Creation, preparation, activation, two sends, two queues, cancellation, execution.
    expect(operations).toHaveLength(9);
    const queuedAt = (
      await chain.getBlock({ blockNumber: operations[6].blockNumber })
    ).timestamp;
    const executedAt = (
      await chain.getBlock({ blockNumber: operations[8].blockNumber })
    ).timestamp;
    expect(executedAt - queuedAt).toBeGreaterThanOrEqual(120n);
    expect(executedAt - queuedAt).toBeLessThanOrEqual(720n);
    const deposit = (owner, blockNumber) =>
      chain.readContract({
        address: config.entryPoint,
        abi: parseAbi(["function balanceOf(address) view returns(uint256)"]),
        functionName: "balanceOf",
        args: [owner],
        blockNumber,
      });
    for (const { args, blockNumber } of operations) {
      expect(args.success).toBe(true);
      expect(args.paymaster).toBe(getAddress(config.paymaster));
      expect(args.actualGasCost).toBeGreaterThan(0n);
      expect(
        (await deposit(config.paymaster, blockNumber - 1n)) -
          (await deposit(config.paymaster, blockNumber)),
      ).toBe(args.actualGasCost);
      expect(await deposit(safe, blockNumber)).toBe(0n);
    }
    expect(await chain.getBalance({ address: safe })).toBe(0n);
  });
});
