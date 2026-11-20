import { formatEther } from "viem";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  KEY,
  parseRecord,
  Wallet,
  type WalletRecord,
  type WalletState,
  type Manifest,
} from "./wallet";
import "./style.css";
function App() {
  const [balance, setBalance] = useState<string>();
  const [wallet, setWallet] = useState<Wallet>();
  const [record, setRecord] = useState<WalletRecord | null>(() =>
    parseRecord(localStorage.getItem(KEY)),
  );
  const [state, setState] = useState<WalletState>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Connecting to local research chain…");
  const [error, setError] = useState("");
  const [settings, setSettings] = useState(false);
  const persist = (r: WalletRecord) => {
    localStorage.setItem(KEY, JSON.stringify(r));
    setRecord({ ...r });
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/local.json", { cache: "no-store" });
        if (!response.ok)
          throw Error(
            "Start the disposable local chain to connect this wallet.",
          );
        const manifest = (await response.json()) as Manifest;
        const w = new Wallet(manifest, persist, setMessage);
        await w.preflight();
        if (!active) return;
        if (!navigator.locks)
          throw Error(
            "This browser cannot safely coordinate wallet changes across tabs.",
          );
        setWallet(w);
        await navigator.locks.request(KEY, async () => {
          const raw = localStorage.getItem(KEY);
          const stored = parseRecord(raw);
          if (raw && !stored) {
            setWallet(undefined);
            throw Error(
              "Saved wallet metadata is invalid. Refusing to create a second wallet.",
            );
          }
          setRecord(stored);
          setState(stored ? await w.inspect(stored) : undefined);
          if (stored)
            setBalance(
              formatEther(await w.client.getBalance({ address: stored.safe })),
            );
        });
        setMessage("");
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : String(e));
          setMessage("");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  async function run(action: "create" | "enable" | "refresh") {
    if (!wallet) return;
    setBusy(true);
    setError("");
    let r = record;
    try {
      if (!navigator.locks)
        throw Error(
          "This browser cannot safely coordinate wallet changes across tabs.",
        );
      await navigator.locks.request(KEY, async () => {
        const latestRaw = localStorage.getItem(KEY);
        r = parseRecord(latestRaw);
        if (latestRaw && !r) throw Error("Saved wallet metadata is invalid.");
        setRecord(r);
        if (action === "create") {
          r ??= await wallet.prepare();
          await wallet.create(r);
        } else if (action === "enable" && r) await wallet.enable(r);
        if (r) {
          setState(await wallet.inspect(r));
          setBalance(
            formatEther(await wallet.client.getBalance({ address: r.safe })),
          );
        }
        setMessage("");
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessage("");
      if (navigator.locks)
        try {
          await navigator.locks.request(KEY, async () => {
            const latest = parseRecord(localStorage.getItem(KEY));
            setRecord(latest);
            setState(latest ? await wallet.inspect(latest) : undefined);
          });
        } catch {
          setState(undefined);
        }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <span className="mark">◈</span>
        <strong>One vault</strong>
        <span className="badge">LOCAL RESEARCH</span>
      </header>
      <section className="card">
        <div className="top">
          <h1>
            {settings
              ? "Settings"
              : record
                ? "Your wallet"
                : "Create your wallet"}
          </h1>
          {record && (
            <button className="text" onClick={() => setSettings(!settings)}>
              {settings ? "← Wallet" : "Settings"}
            </button>
          )}
        </div>
        {!record ? (
          <>
            <p>
              Create a Safe with a passkey. Add spending protection later, at
              the same address.
            </p>
            <button
              disabled={!wallet || busy}
              onClick={() => void run("create")}
            >
              Create wallet
            </button>
          </>
        ) : (
          <>
            <p className="label">
              {state === "ordinary" || state === "enabled"
                ? "SAFE ADDRESS"
                : "PREDICTED SAFE ADDRESS · NOT VERIFIED"}
            </p>
            <p className="address">{record.safe}</p>
            {!settings ? (
              <>
                <div className="balance">
                  {balance ?? "—"} <span>ETH</span>
                </div>
                <p>
                  {state === "enabled"
                    ? "Tiered spending enabled"
                    : state === "ordinary"
                      ? "Wallet ready · tiered spending is off"
                      : state === "undeployed"
                        ? "Creation needs to finish"
                        : state === "blocked"
                          ? "Verification failed · actions locked"
                          : "Checking wallet…"}
                </p>
                {state === "undeployed" && (
                  <button disabled={busy} onClick={() => void run("create")}>
                    Finish creating wallet
                  </button>
                )}
              </>
            ) : (
              <>
                <h2>Tiered spending</h2>
                <p>
                  {state === "enabled"
                    ? "Enabled · verified onchain"
                    : state === "ordinary"
                      ? "Off · your Safe currently has no spending limits"
                      : "Not verified"}
                </p>
                <dl>
                  <div>
                    <dt>Primary passkey</dt>
                    <dd>0.001 ETH per transaction and day</dd>
                  </div>
                  <div>
                    <dt>With secondary passkey</dt>
                    <dd>0.003 ETH shared daily limit</dd>
                  </div>
                  <div>
                    <dt>Above the daily limit</dt>
                    <dd>120-second delay · cancellable</dd>
                  </div>
                  <div>
                    <dt>Queued transfer expires</dt>
                    <dd>600 seconds after the delay</dd>
                  </div>
                </dl>
                <p className="small">One local research recipient:</p>
                <p className="address small">{wallet?.manifest.recipient}</p>
                <p className="small">
                  A distinct secondary passkey is required. It is not another
                  Safe owner. Separate credentials may still share a device or
                  sync account. Losing either factor can block future access.
                </p>
                {state === "ordinary" && (
                  <button disabled={busy} onClick={() => void run("enable")}>
                    {record.secondary
                      ? "Continue enabling tiered spending"
                      : "Enable tiered spending"}
                  </button>
                )}
                {state === "enabled" && (
                  <div className="verified">
                    ✓ Both guard slots, signers, limits and Delay verified
                  </div>
                )}
              </>
            )}
            <button
              className="text refresh"
              disabled={busy || !wallet}
              onClick={() => void run("refresh")}
            >
              Refresh onchain status
            </button>
          </>
        )}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
        {record?.pending && (
          <p className="small">
            Pending operation:{" "}
            <span className="address">{record.pending.hash}</span>
          </p>
        )}
      </section>
      <footer>
        Disposable local chain · 31337. Keep this Safe unfunded.
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
