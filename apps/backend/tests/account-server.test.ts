import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/account-store";
import {
  createAccountServer,
  type AccountGateway,
} from "../src/account-server";
import { loadBackendConfig } from "../src/config";
import { softwareAuthenticator } from "./automatic-http-fixtures";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(logs?: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "vault-account-http-"));
  const config = {
    ...loadBackendConfig({
      BACKEND_PROFILE: "local",
      BACKEND_RELAY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      BACKEND_RPC_URL: "https://unused.invalid",
      BACKEND_JOURNAL_PATH: join(root, "s.json"),
      BACKEND_PROVISIONING_JOURNAL_PATH: join(root, "p.json"),
      BACKEND_PROVISIONING_REVIEW_DIRECTORY: join(root, "reviews"),
    }),
    port: 0,
  };
  const store = new AccountStore(config);
  const gateway: AccountGateway = {
    handlers: async () =>
      ({
        currentVault: () => undefined,
        getReadiness: () => ({ provisioningReady: true, writesReady: false }),
      }) as never,
    provision: async () => {
      throw Error("not used");
    },
    prepare: async () => {
      throw Error("not used");
    },
    submit: async () => {
      throw Error("not used");
    },
    status: async (_account, id) => {
      if (id === "pending")
        throw new Error(
          "identity Sepolia RPC request failed https://private.invalid/secret",
        );
      return { state: "confirmed" };
    },
  };
  const backend = createAccountServer(config, store, gateway, {
    log: (event: unknown) => logs?.push(event),
  });
  await new Promise<void>((resolve) =>
    backend.server.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(async () => {
    await backend.close();
    store.close();
  });
  const url = `http://127.0.0.1:${(backend.server.address() as { port: number }).port}`;
  function client() {
    let cookie = "",
      csrf = "",
      account = "";
    return {
      async request(
        path: string,
        body?: unknown,
        extra: Record<string, string> = {},
      ) {
        const response = await fetch(url + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: config.origin,
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
            ...(csrf ? { "x-csrf-token": csrf } : {}),
            ...(account ? { "x-vault-account": account } : {}),
            ...extra,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const set = response.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0]!;
        const data = await response.json();
        if (data.csrfToken) csrf = data.csrfToken;
        if (data.account) account = data.account.id;
        return { status: response.status, data };
      },
      clear() {
        cookie = "";
        csrf = "";
        account = "";
      },
    };
  }
  return { store, client };
}
describe("multi-user passkey HTTP", () => {
  it("logs request arrival and completion with a correlated ID, safe route, status and duration", async () => {
    const events: unknown[] = [];
    const { client } = await fixture(events);
    const result = await client().request("/health");
    expect(result.status).toBe(200);
    expect(events).toEqual([
      expect.objectContaining({
        level: "info",
        code: "request_received",
        method: "GET",
        route: "/health",
        requestId: expect.any(String),
      }),
      expect.objectContaining({
        level: "info",
        code: "request_completed",
        method: "GET",
        route: "/health",
        status: 200,
        durationMs: expect.any(Number),
      }),
    ]);
    expect((events[0] as { requestId: string }).requestId).toBe(
      (events[1] as { requestId: string }).requestId,
    );
  });
  it("keeps cookies, headers, bodies, query values and unknown path values out of request logs", async () => {
    const events: unknown[] = [];
    const { client } = await fixture(events);
    await client().request(
      "/private-path-token?secret=query-token",
      { secret: "body-token" },
      {
        cookie: "secret=cookie-token",
        authorization: "Bearer header-token",
      },
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "request_received",
        route: "unmatched",
        method: "POST",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ code: "request_completed", status: 404 }),
    );
    expect(JSON.stringify(events)).not.toMatch(
      /private-path-token|query-token|body-token|cookie-token|header-token/,
    );
  });
  it("creates independent accounts and signs in after browser reset using only the original first credential", async () => {
    const { client, store } = await fixture();
    const a = client(),
      b = client();
    const setup = await a.request("/v1/auth/setup", {});
    expect(setup.status).toBe(200);
    const other = await b.request("/v1/auth/setup", {});
    expect(other.data.account.id).not.toBe(setup.data.account.id);
    const key = softwareAuthenticator("primary");
    const options = await a.request("/v1/registrations/primary/options", {});
    expect(options.data.userHandle).toBe(setup.data.account.userHandle);
    expect(options.data.authenticatorAttachment).toBeUndefined();
    const registered = await a.request("/v1/registrations/primary/verify", {
      sessionId: options.data.sessionId,
      registration: key.registration(options.data.challenge),
    });
    expect(registered.status).toBe(200);
    a.clear();
    const login = await a.request("/v1/auth/login/options", {});
    const assertion = key.assertion(login.data.challenge);
    assertion.response.userHandle = setup.data.account.userHandle;
    const signed = await a.request("/v1/auth/login/verify", {
      sessionId: login.data.sessionId,
      assertion,
    });
    expect(signed.status).toBe(200);
    expect(signed.data).toMatchObject({
      authenticated: true,
      account: { id: setup.data.account.id, primaryCredentialId: key.id },
    });
    expect(store.credentials(setup.data.account.id).length).toBe(1);
    expect((await a.request("/v1/submissions/same")).status).toBe(200);
    expect((await a.request("/v1/submissions/pending")).data.code).toBe(
      "rpc_request_failed",
    );
    expect(
      (
        await a.request("/v1/vaults/current", undefined, {
          "x-vault-account": other.data.account.id,
        })
      ).status,
    ).toBe(403);
    expect((await a.request("/v1/auth/logout", {})).status).toBe(200);
    expect((await a.request("/v1/submissions/same")).status).toBe(401);
  });
  it("rejects login replay, wrong handle, cross-origin and missing CSRF", async () => {
    const { store, client } = await fixture(),
      account = store.createAccount(),
      key = softwareAuthenticator("primary");
    store.storeCredential(
      account.id,
      {
        id: key.id,
        role: "primary",
        ...key.coordinates,
        publicKey: (await import("../src/webauthn")).encodeP256CosePublicKey(
          key.coordinates,
        ),
        counter: 0,
      },
      account.userHandle,
    );
    const browser = client(),
      options = await browser.request("/v1/auth/login/options", {});
    const assertion = key.assertion(options.data.challenge);
    assertion.response.userHandle = "wrong";
    expect(
      (
        await browser.request("/v1/auth/login/verify", {
          sessionId: options.data.sessionId,
          assertion,
        })
      ).status,
    ).toBe(400);
    assertion.response.userHandle = account.userHandle;
    expect(
      (
        await browser.request("/v1/auth/login/verify", {
          sessionId: options.data.sessionId,
          assertion,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await browser.request(
          "/v1/auth/setup",
          {},
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const fresh = await browser.request("/v1/auth/login/options", {});
    const valid = key.assertion(fresh.data.challenge);
    valid.response.userHandle = account.userHandle;
    expect(
      (
        await browser.request(
          "/v1/auth/login/verify",
          { sessionId: fresh.data.sessionId, assertion: valid },
          { "x-csrf-token": "" },
        )
      ).status,
    ).toBe(403);
  });
});

it("targeted setup authentication accepts an omitted handle but never overwrites the first discoverable handle", async () => {
  const { client } = await fixture(),
    browser = client(),
    setup = await browser.request("/v1/auth/setup", {}),
    key = softwareAuthenticator("primary");
  const first = await browser.request("/v1/registrations/primary/options", {});
  const registration = key.registration(first.data.challenge);
  registration.authenticatorAttachment = "cross-platform";
  await browser.request("/v1/registrations/primary/verify", {
    sessionId: first.data.sessionId,
    registration,
  });
  const login = await browser.request("/v1/auth/login/options", {});
  const signed = await browser.request("/v1/auth/login/verify", {
    sessionId: login.data.sessionId,
    assertion: key.assertion(login.data.challenge),
  });
  expect(signed.status).toBe(200);
  const second = await browser.request(
    "/v1/registrations/secondary/options",
    {},
  );
  expect(second.data.userHandle).not.toBe(first.data.userHandle);
  expect(first.data.userHandle).toBe(setup.data.account.userHandle);
});
