import { Download, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import {
  UPDATE_READY_EVENT,
  activateWaitingServiceWorkerWhenSafe,
  registerWalletServiceWorker,
  useWalletOnline,
} from "@/lib/pwa";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export function PwaStatus() {
  const online = useWalletOnline();
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent>();
  const [updateReady, setUpdateReady] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(undefined);
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener(UPDATE_READY_EVENT, onUpdate);
    void registerWalletServiceWorker()
      .then(setRegistration)
      .catch(() => undefined);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener(UPDATE_READY_EVENT, onUpdate);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(undefined);
  };
  const reloadForUpdate = () => {
    if (!registration?.waiting) return;
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
      once: true,
    });
    activateWaitingServiceWorkerWhenSafe(registration);
  };

  if (!online) {
    return (
      <div
        role="status"
        className="mt-3 flex min-h-11 items-center gap-2 rounded-2xl bg-danger-soft px-4 py-2 text-sm font-semibold text-danger-ink"
      >
        <WifiOff className="size-4 shrink-0" aria-hidden />
        Offline read-only mode. Chain data and wallet writes are unavailable.
      </div>
    );
  }
  if (updateReady) {
    return (
      <div
        role="status"
        className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-2xl bg-primary-soft px-4 py-2 text-sm text-primary"
      >
        <span className="font-semibold">Update ready. Reload only at a safe boundary.</span>
        <button
          type="button"
          onClick={reloadForUpdate}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 font-semibold"
        >
          <RefreshCw className="size-4" aria-hidden /> Reload to update
        </button>
      </div>
    );
  }
  if (installPrompt) {
    return (
      <div
        role="status"
        className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-2xl bg-primary-soft px-4 py-2 text-sm text-primary"
      >
        <span className="font-semibold">Install this Sepolia prototype.</span>
        <button
          type="button"
          onClick={() => void install()}
          className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl px-2 font-semibold"
        >
          <Download className="size-4" aria-hidden /> Install wallet
        </button>
      </div>
    );
  }
  return null;
}
