const SHELL_CACHE = "wallet-shell-v1";
const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then(async (cache) => {
    await Promise.all(SHELL_URLS.map(async (url) => {
      const response = await fetch(url, { cache: "reload" });
      if (cacheable(response)) await cache.put(url, response);
    }));
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((key) => key.startsWith("wallet-shell-") && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function forbidsCaching(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return true;
  if (request.headers?.get("cache-control")?.toLowerCase().includes("no-store")) return true;
  return url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/") || url.pathname.startsWith("/rpc/");
}

function cacheable(response) {
  return response.ok && !response.headers.get("cache-control")?.toLowerCase().includes("no-store");
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    return await fetch(request);
  } catch {
    const shell = await cache.match("/");
    if (shell) return shell;
    throw new Error("wallet shell unavailable offline");
  }
}

async function immutableStaticAsset(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (forbidsCaching(request, url)) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest") {
    event.respondWith(immutableStaticAsset(request));
  }
});
