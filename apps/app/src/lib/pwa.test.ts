import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateWaitingServiceWorkerWhenSafe,
  beginWalletCriticalFlow,
  registerWalletServiceWorker,
} from "./pwa";

const publicPath = (...parts: string[]) => resolve(process.cwd(), "public", ...parts);

function pngDimensions(path: string): readonly [number, number] {
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

type WorkerEvent = {
  request?: { method: string; url: string; mode?: string; headers: Headers };
  waitUntil?: (promise: Promise<unknown>) => void;
  respondWith?: (promise: Promise<Response>) => void;
};

function serviceWorkerHarness(fetcher: (request: unknown) => Promise<Response>) {
  const handlers = new Map<string, (event: WorkerEvent) => void>();
  const stored = new Map<string, Response>();
  const cache = {
    addAll: vi.fn(async (urls: readonly string[]) => {
      for (const url of urls) stored.set(url, new Response(`cached:${url}`));
    }),
    match: vi.fn(async (request: unknown) => {
      const key = typeof request === "string" ? request : new URL((request as { url: string }).url).pathname;
      return stored.get(key)?.clone();
    }),
    put: vi.fn(async (request: unknown, response: Response) => {
      const key = typeof request === "string" ? request : new URL((request as { url: string }).url).pathname;
      stored.set(key, response.clone());
    }),
  };
  const context = {
    URL,
    Response,
    fetch: fetcher,
    caches: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => ["wallet-shell-old", "unrelated-cache"]),
      delete: vi.fn(async () => true),
    },
    self: {
      location: { origin: "https://vault.example" },
      clients: { claim: vi.fn(async () => undefined) },
      skipWaiting: vi.fn(),
      addEventListener: (type: string, handler: (event: WorkerEvent) => void) => handlers.set(type, handler),
    },
  };
  vm.runInNewContext(readFileSync(publicPath("service-worker.js"), "utf8"), context);
  const dispatchFetch = async (request: WorkerEvent["request"]) => {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")?.({ request, respondWith: (promise) => { response = promise; } });
    return response ? response : undefined;
  };
  return { cache, context, dispatchFetch, handlers, stored };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("wallet PWA artifacts", () => {
  it("publishes an installable standalone manifest with exact PNG sizes", () => {
    const manifest = JSON.parse(readFileSync(publicPath("manifest.webmanifest"), "utf8")) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };

    expect(manifest).toMatchObject({
      name: "Sepolia USDC Vault",
      short_name: "USDC Vault",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#3158d4",
      background_color: "#f7f7fb",
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({ src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" }),
      expect.objectContaining({ src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" }),
    ]));
    expect(pngDimensions(publicPath("icons", "icon-192.png"))).toEqual([192, 192]);
    expect(pngDimensions(publicPath("icons", "icon-512.png"))).toEqual([512, 512]);
    expect(pngDimensions(publicPath("icons", "icon-maskable-512.png"))).toEqual([512, 512]);
  });

  it("serves direct navigation from network and falls back only to the cached shell", async () => {
    const fetcher = vi.fn(async (request: unknown) => new Response(`network:${(request as { url: string }).url}`));
    const harness = serviceWorkerHarness(fetcher);
    let install: Promise<unknown> | undefined;
    harness.handlers.get("install")?.({ waitUntil: (promise) => { install = promise; } });
    await install;

    const send = { method: "GET", url: "https://vault.example/send", mode: "navigate", headers: new Headers() };
    expect(await (await harness.dispatchFetch(send))?.text()).toBe("network:https://vault.example/send");
    const detail = { method: "GET", url: "https://vault.example/activity/42", mode: "navigate", headers: new Headers() };
    expect(await (await harness.dispatchFetch(detail))?.text()).toBe("network:https://vault.example/activity/42");

    fetcher.mockRejectedValueOnce(new TypeError("offline"));
    expect(await (await harness.dispatchFetch(send))?.text()).toBe("cached:/");
  });

  it("never intercepts security traffic and never caches no-store responses", async () => {
    const fetcher = vi.fn(async () => new Response("fresh", { headers: { "cache-control": "no-store" } }));
    const harness = serviceWorkerHarness(fetcher);
    const request = (url: string, method = "GET", headers = new Headers()) => ({ method, url, mode: "cors", headers });

    expect(await harness.dispatchFetch(request("https://api.example/v1/submissions"))).toBeUndefined();
    expect(await harness.dispatchFetch(request("https://vault.example/v1/submissions"))).toBeUndefined();
    expect(await harness.dispatchFetch(request("https://rpc.example/", "POST"))).toBeUndefined();
    expect(await harness.dispatchFetch(request("https://vault.example/assets/app.js", "POST"))).toBeUndefined();
    expect(await harness.dispatchFetch(request("https://vault.example/assets/app.js", "GET", new Headers({ "cache-control": "no-store" })))).toBeUndefined();

    const response = await harness.dispatchFetch(request("https://vault.example/assets/app.js"));
    expect(await (await response)?.text()).toBe("fresh");
    expect(harness.cache.put).not.toHaveBeenCalled();
  });
});

describe("service-worker lifecycle", () => {
  it("registers the versioned wallet worker without HTTP cache reuse", async () => {
    const registration = { waiting: null, installing: null, addEventListener: vi.fn() } as unknown as ServiceWorkerRegistration;
    const register = vi.fn(async () => registration);
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    await expect(registerWalletServiceWorker()).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith("/service-worker.js", { scope: "/", updateViaCache: "none" });
  });

  it("defers update activation until the credential/submission flow ends", async () => {
    const postMessage = vi.fn();
    const registration = { waiting: { postMessage } } as unknown as ServiceWorkerRegistration;
    const finishFlow = beginWalletCriticalFlow();

    expect(activateWaitingServiceWorkerWhenSafe(registration)).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
    finishFlow();
    expect(postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });
});
