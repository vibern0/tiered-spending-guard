import { expect } from "chai";
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { createPinnedLookup, createWebhookNotifier, publicAlert, type ActivityAlert, type Notifier } from "../../../src/monitoring/notifier";

const alert: ActivityAlert = {
  kind: "step-up-executed",
  chainId: 31337,
  safe: getAddress("0x0000000000000000000000000000000000000001"),
  guard: getAddress("0x0000000000000000000000000000000000000002"),
  transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000001",
  blockNumber: 10n,
  logIndex: 0,
  token: getAddress("0x0000000000000000000000000000000000000004"),
  recipient: getAddress("0x0000000000000000000000000000000000000005"),
  amount: 25n,
  baseSpent: 7n,
  instantSpent: 25n,
  window: 1n,
};

const delayedQueued: ActivityAlert = {
  kind: "delayed-queued",
  chainId: 31337,
  safe: alert.safe,
  delay: getAddress("0x0000000000000000000000000000000000000002"),
  transactionHash: alert.transactionHash,
  blockNumber: 10n,
  logIndex: 0,
  queueNonce: 1n,
  queueFingerprint: alert.transactionHash,
  createdAt: 10n,
  to: alert.safe,
  value: 0n,
  data: "0x",
  operation: 0,
};

const delayedCancelled: ActivityAlert = {
  kind: "delayed-cancelled",
  chainId: 31337,
  safe: alert.safe,
  delay: delayedQueued.delay,
  transactionHash: alert.transactionHash,
  blockNumber: 10n,
  logIndex: 0,
  cancelledThrough: 1n,
};

const delayedExecuted: ActivityAlert = {
  ...delayedQueued,
  kind: "delayed-executed",
  transactionHash: getAddress("0x0000000000000000000000000000000000000006") as `0x${string}`,
  blockNumber: 20n,
};

const delayedExpired: ActivityAlert = {
  ...delayedQueued,
  kind: "delayed-expired",
  transactionHash: getAddress("0x0000000000000000000000000000000000000007") as `0x${string}`,
  blockNumber: 30n,
  expiresAt: 25n,
};

const alerts: readonly ActivityAlert[] = [alert, delayedQueued, delayedCancelled, delayedExecuted, delayedExpired];

describe("non-authorizing notifiers", () => {
  const expectRequiredFieldError = (field:string, value:ActivityAlert) => {
    try { publicAlert(value as never); expect.fail("expected publicAlert to reject"); }
    catch (error) { expect(String(error)).to.contain("required"); expect(String(error)).to.contain(field); }
  };
  it("exposes only notification and does not retain a signing or execution capability", async () => {
    const calls: unknown[] = [];
    const notifier: Notifier = { notify: async value => { calls.push(value); } };
    expect(Object.keys(notifier)).to.deep.equal(["notify"]);
    await notifier.notify(alert);
    expect(calls).to.have.length(1);
  });

  it("sends only serialized public alert data to a webhook", async () => {
    let body = "";
    const notifier = createWebhookNotifier("https://example.invalid/hook", async (_url, init) => {
      body = String(init?.body);
      return new Response(null, { status: 204 });
    });
    const evidence = await notifier.notify(alert);
    expect(body).to.contain('"kind":"step-up-executed"');
    expect(body).to.not.contain("privateKey");
    expect(body).to.not.contain("sign");
    expect(evidence).to.deep.include({ channel: "webhook", httpStatus: 204 });
    expect(evidence && "payloadHash" in evidence ? evidence.payloadHash : undefined).to.equal(`0x${createHash("sha256").update(body).digest("hex")}`);
    expect(evidence && "deliveredAt" in evidence ? Number.isNaN(Date.parse(evidence.deliveredAt)) : true).to.equal(false);
  });

  it("sanitizes request failures so endpoint and credentials cannot leak", async () => {
    const secret = "opaque-receiver-token";
    const notifier = createWebhookNotifier(`https://example.invalid/${secret}`, async () => { throw new Error(`connect failed at https://example.invalid/${secret}`); });
    try { await notifier.notify(alert); expect.fail("expected delivery failure"); }
    catch (error) { expect(String(error)).to.equal("Error: notification webhook request failed"); expect(String(error)).to.not.contain(secret); }
  });

  it("rejects non-HTTPS webhook endpoints and embedded credentials", () => {
    expect(() => createWebhookNotifier("http://example.invalid/hook")).to.throw(/HTTPS/);
    expect(() => createWebhookNotifier("https://user:password@example.invalid/hook")).to.throw(/credentials/);
    for (const endpoint of ["https://127.0.0.1/hook", "https://10.0.0.4/hook", "https://192.168.1.2/hook", "https://[::1]/hook", "https://service.internal/hook"]) {
      expect(() => createWebhookNotifier(endpoint)).to.throw(/public/);
    }
  });

  it("pins HTTPS delivery to the public address that passed DNS validation", async () => {
    const { createPinnedWebhookFetch } = await import("../../../src/monitoring/notifier");
    let requestedAddress = "";
    const fetcher = createPinnedWebhookFetch(
      async () => [{ address: "93.184.216.34", family: 4 }],
      async (_url, options) => {
        requestedAddress = options.lookupAddress;
        return { ok: true, status: 204 };
      },
    );

    await fetcher(new URL("https://example.invalid/hook"), { method: "POST", body: "{}" });

    expect(requestedAddress).to.equal("93.184.216.34");
  });

  it("returns the pinned address in the callback shape requested by Node", async () => {
    const pinnedLookup = createPinnedLookup("93.184.216.34", 4);
    const invoke = (options: { all?: boolean }) => new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
      pinnedLookup("example.invalid", options, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address, family });
      });
    });

    expect(await invoke({ all: true })).to.deep.equal({ address: [{ address: "93.184.216.34", family: 4 }], family: undefined });
    expect(await invoke({ all: false })).to.deep.equal({ address: "93.184.216.34", family: 4 });
    expect(await invoke({})).to.deep.equal({ address: "93.184.216.34", family: 4 });
  });

  it("validates DNS without connecting at readiness and re-resolves for pinned delivery", async () => {
    const { createPinnedWebhookFetch } = await import("../../../src/monitoring/notifier");
    let resolutions = 0;
    let connections = 0;
    const fetcher = createPinnedWebhookFetch(
      async () => { resolutions++; return [{ address: "93.184.216.34", family: 4 }]; },
      async () => { connections++; return { ok: true, status: 204 }; },
    );
    const endpoint = new URL("https://example.invalid/hook");

    await fetcher.ready(endpoint);
    expect(resolutions).to.equal(1);
    expect(connections).to.equal(0);
    await fetcher(endpoint, { method: "POST", body: "{}" });
    expect(resolutions).to.equal(2);
    expect(connections).to.equal(1);
  });

  it("rejects ambiguous public-private DNS readiness without connecting", async () => {
    const { createPinnedWebhookFetch } = await import("../../../src/monitoring/notifier");
    let connected = false;
    const fetcher = createPinnedWebhookFetch(
      async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      async () => { connected = true; return { ok: true, status: 204 }; },
    );
    await expect(fetcher.ready(new URL("https://example.invalid/hook"))).to.be.rejectedWith(/public/);
    expect(connected).to.equal(false);
  });

  it("never connects when any DNS answer is private", async () => {
    const { createPinnedWebhookFetch } = await import("../../../src/monitoring/notifier");
    let connected = false;
    const fetcher = createPinnedWebhookFetch(
      async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      async () => { connected = true; return { ok: true, status: 204 }; },
    );

    try {
      await fetcher(new URL("https://example.invalid/hook"), { method: "POST", body: "{}" });
      expect.fail("expected private DNS result to be rejected");
    } catch (error) {
      expect(String(error)).to.contain("public");
    }
    expect(connected).to.equal(false);
  });

  it("rejects IPv4-mapped IPv6 DNS answers for loopback", async () => {
    const { createPinnedWebhookFetch } = await import("../../../src/monitoring/notifier");
    let connected = false;
    const fetcher = createPinnedWebhookFetch(
      async () => [{ address: "::ffff:7f00:1", family: 6 }],
      async () => { connected = true; return { ok: true, status: 204 }; },
    );

    try {
      await fetcher(new URL("https://example.invalid/hook"), { method: "POST", body: "{}" });
      expect.fail("expected mapped loopback to be rejected");
    } catch (error) {
      expect(String(error)).to.contain("public");
    }
    expect(connected).to.equal(false);
  });

  it("rejects unknown and sensitive alert fields at the notifier boundary", async () => {
    expect(() => publicAlert({ ...alert, privateKey: "secret" } as never)).to.throw(/unknown|sensitive/i);
    expect(() => publicAlert({ ...alert, delay: alert.guard } as never)).to.throw(/unknown|sensitive/i);
    expect(() => publicAlert({ ...alert, amount: "25" } as never)).to.throw(/type|required/i);
    expect(() => publicAlert({ ...alert, recipient: undefined } as never)).to.throw(/required/i);
  });

  for (const field of ["safe", "transactionHash", "blockNumber", "logIndex"] as const) {
    it(`rejects omission of common field ${field} for every alert kind`, () => {
      for (const value of alerts) {
        const omitted = { ...value } as Record<string, unknown>;
        delete omitted[field];
        expectRequiredFieldError(field, omitted as ActivityAlert);
      }
    });
  }

  it("rejects a type mismatch in each common public alert field", () => {
    expect(() => publicAlert({ ...alert, safe: 1 } as never)).to.throw(/type/i);
    expect(() => publicAlert({ ...alert, transactionHash: 1 } as never)).to.throw(/type/i);
    expect(() => publicAlert({ ...alert, blockNumber: 10 } as never)).to.throw(/type/i);
    expect(() => publicAlert({ ...alert, logIndex: 0n } as never)).to.throw(/type/i);
  });

  for (const field of ["to", "value", "data", "operation", "queueFingerprint"] as const) {
    it(`rejects omission of delayed lifecycle field ${field}`, () => {
      for (const value of [delayedQueued, delayedExecuted, delayedExpired]) {
        const omitted = { ...value } as Record<string, unknown>;
        delete omitted[field];
        expectRequiredFieldError(field, omitted as ActivityAlert);
      }
    });
  }

  it("rejects delayed lifecycle tuple and fingerprint type mismatches", () => {
    for (const [field, value] of [["to", 1], ["value", "0"], ["data", 1], ["operation", 0n], ["queueFingerprint", 1]] as const) {
      expect(() => publicAlert({ ...delayedQueued, [field]: value } as never)).to.throw(/type/i);
    }
  });
});
