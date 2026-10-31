import { useSyncExternalStore } from "react";

const UPDATE_READY_EVENT = "wallet-pwa-update-ready";
let activeWalletFlows = 0;
const deferredRegistrations = new Set<ServiceWorkerRegistration>();

function notifyUpdateReady(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(UPDATE_READY_EVENT));
}

function activateWaitingWorker(registration: ServiceWorkerRegistration): boolean {
  if (!registration.waiting) return false;
  registration.waiting.postMessage({ type: "SKIP_WAITING" });
  deferredRegistrations.delete(registration);
  return true;
}

export function activateWaitingServiceWorkerWhenSafe(
  registration: ServiceWorkerRegistration,
): boolean {
  if (!registration.waiting) return false;
  if (activeWalletFlows > 0) {
    deferredRegistrations.add(registration);
    return false;
  }
  return activateWaitingWorker(registration);
}

export function beginWalletCriticalFlow(): () => void {
  activeWalletFlows += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeWalletFlows = Math.max(0, activeWalletFlows - 1);
    if (activeWalletFlows === 0) {
      for (const registration of [...deferredRegistrations]) activateWaitingWorker(registration);
    }
  };
}

export async function runWalletCriticalFlow<T>(operation: () => Promise<T>): Promise<T> {
  const finish = beginWalletCriticalFlow();
  try {
    return await operation();
  } finally {
    finish();
  }
}

export async function registerWalletServiceWorker(): Promise<
  ServiceWorkerRegistration | undefined
> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return undefined;
  const registration = await navigator.serviceWorker.register("/service-worker.js", {
    scope: "/",
    updateViaCache: "none",
  });
  if (registration.waiting) notifyUpdateReady();
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) notifyUpdateReady();
    });
  });
  return registration;
}

function subscribeOnline(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

function onlineSnapshot(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function useWalletOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, onlineSnapshot, () => true);
}

export { UPDATE_READY_EVENT };
