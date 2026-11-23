import { formatUnits } from "viem";
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
import { transferTier, tokenAmount } from "./transfer";
import { queueStatus, type Queued } from "./queue";
import { useSpending } from "./useSpending";
import "./style.css";
function App() {
  const [balance, setBalance] = useState<string>();
  const [wallet, setWallet] = useState<Wallet>();
  const [record, setRecord] = useState<WalletRecord | null>(null);
  const [state, setState] = useState<WalletState>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Connecting to local research chain…");
  const [error, setError] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [confirmation, setConfirmation] = useState("");
  const [settings, setSettings] = useState(false);
  const { snapshot, problem } = useSpending(
    wallet,
    record,
    state === "enabled" && !busy,
  );
  let tier: ReturnType<typeof transferTier> | undefined;
  if (snapshot) {
    try {
      tier = transferTier(tokenAmount(amount), snapshot);
    } catch {
      /* Incomplete amount while typing. */
    }
  }
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
        const networkKey = KEY + ":" + manifest.rpcUrl;
        const w = new Wallet(
          manifest,
          (r) => {
            localStorage.setItem(networkKey, JSON.stringify(r));
            setRecord({ ...r });
          },
          setMessage,
        );
        await w.preflight();
        if (!active) return;
        if (!navigator.locks)
          throw Error(
            "This browser cannot safely coordinate wallet changes across tabs.",
          );
        await navigator.locks.request(networkKey, async () => {
          const scoped = localStorage.getItem(networkKey);
          const raw = scoped ?? localStorage.getItem(KEY);
          const stored = parseRecord(raw);
          if (raw && !stored) {
            setWallet(undefined);
            throw Error(
              "Saved wallet metadata is invalid. Refusing to create a second wallet.",
            );
          }
          if (scoped === null && stored?.pending)
            throw Error(
              "Resolve the pending operation in the previous wallet before using this local chain.",
            );
          if (scoped === null && raw && stored) {
            await w.validateRecord(stored);
            localStorage.setItem(networkKey, raw);
          }
          setWallet(w);
          setRecord(stored);
          setRecipient(stored?.recipient ?? manifest.recipient);
          setState(stored ? await w.inspect(stored) : undefined);
          if (stored)
            setBalance(formatUnits(await w.tokenBalance(stored.safe), 18));
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
  async function run(
    action: "create" | "enable" | "refresh" | "send" | "cancel" | "execute",
    selected?: Queued,
  ) {
    if (!wallet) return;
    const networkKey = KEY + ":" + wallet.manifest.rpcUrl;
    setBusy(true);
    setConfirmation("");
    setError("");
    let r = record;
    try {
      if (!navigator.locks)
        throw Error(
          "This browser cannot safely coordinate wallet changes across tabs.",
        );
      await navigator.locks.request(networkKey, async () => {
        const latestRaw = localStorage.getItem(networkKey);
        r = parseRecord(latestRaw);
        if (latestRaw && !r) throw Error("Saved wallet metadata is invalid.");
        setRecord(r);
        if (action === "create") {
          r ??= await wallet.prepare();
          await wallet.create(r);
        } else if (action === "enable" && r) await wallet.enable(r, recipient);
        else if (action === "send" && r) {
          if (!tier) throw Error("Review the amount and current usage first.");
          const result = await wallet.send(r, recipient, amount, tier);
          setConfirmation(
            `${result === "delayed" ? "Queued" : "Sent"} ${amount} GLD to ${recipient}.`,
          );
        } else if (
          (action === "cancel" || action === "execute") &&
          r &&
          selected
        ) {
          await wallet.manageWithdrawal(r, selected, action);
          setConfirmation(
            `Withdrawal #${selected.nonce} ${action === "cancel" ? "cancelled" : "executed"}.`,
          );
        }
        if (r) {
          setState(await wallet.inspect(r));
          setBalance(formatUnits(await wallet.tokenBalance(r.safe), 18));
        }
        setMessage("");
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setMessage("");
      if (navigator.locks)
        try {
          await navigator.locks.request(networkKey, async () => {
            const latest = parseRecord(localStorage.getItem(networkKey));
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
                  {balance ?? "—"} <span>GLD</span>
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
                {state === "enabled" && snapshot && (
                  <section aria-label="Daily usage">
                    <h2>Daily usage</h2>
                    <dl className="usage">
                      <div>
                        <dt>One-passkey threshold</dt>
                        <dd>{formatUnits(snapshot.onePasskey, 18)} / 10 GLD</dd>
                      </div>
                      <div>
                        <dt>Total instant spending</dt>
                        <dd>{formatUnits(snapshot.combined, 18)} / 30 GLD</dd>
                      </div>
                      <div>
                        <dt>Delayed withdrawals executed</dt>
                        <dd>{formatUnits(snapshot.delayed, 18)} GLD</dd>
                      </div>
                    </dl>
                    <p className="small">
                      Resets at 00:00 UTC. Queued withdrawals do not use the
                      instant allowance.
                    </p>
                  </section>
                )}
                {state === "enabled" && !snapshot && !busy && (
                  <p role="status">
                    {problem || "Reading daily usage and withdrawals…"}
                  </p>
                )}
                {state === "enabled" && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run("send");
                    }}
                  >
                    <label>
                      Recipient
                      <input required value={recipient} readOnly />
                    </label>
                    <label>
                      Amount (GLD)
                      <input
                        required
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </label>
                    {tier === "base" && <p>Requires one passkey.</p>}
                    {tier === "step-up" && <p>Requires both passkeys.</p>}
                    {tier === "delayed" && (
                      <p>
                        Both passkeys will queue the full amount. You can
                        execute it after 120 seconds.
                      </p>
                    )}
                    <button disabled={busy || !tier}>
                      {tier === "delayed" ? "Queue GLD" : "Send GLD"}
                    </button>
                  </form>
                )}
                {state === "enabled" && snapshot && (
                  <section aria-label="Withdrawal queue">
                    <h2>Withdrawal queue</h2>
                    {!snapshot.queue.length && <p>No pending withdrawals.</p>}
                    {snapshot.queue.map((item, index) => {
                      const status = queueStatus(item, snapshot.now);
                      return (
                        <article key={item.nonce.toString()}>
                          <strong>
                            #{String(item.nonce)} ·{" "}
                            {formatUnits(item.amount, 18)} GLD
                          </strong>
                          <p className="address">{item.recipient}</p>
                          <p>
                            {status === "expired"
                              ? "Expired"
                              : status === "waiting"
                                ? `Ready in ${item.readyAt - snapshot.now}s`
                                : `Ready · expires in ${item.expiresAt - snapshot.now}s`}
                          </p>
                          {index === 0 ? (
                            <div className="queue-actions">
                              <button
                                disabled={busy || status !== "ready"}
                                onClick={() => void run("execute", item)}
                              >
                                Execute withdrawal
                              </button>
                              <button
                                disabled={busy}
                                onClick={() => void run("cancel", item)}
                              >
                                Cancel withdrawal
                              </button>
                            </div>
                          ) : (
                            <p className="small">
                              Available after earlier withdrawals are resolved.
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </section>
                )}
                {state === "ordinary" && (
                  <button onClick={() => setSettings(true)}>Send GLD</button>
                )}
                {state === "undeployed" && (
                  <button disabled={busy} onClick={() => void run("create")}>
                    Finish creating wallet
                  </button>
                )}
              </>
            ) : (
              <>
                <h2>Smart contracts</h2>
                <p>
                  <strong>Gold (GLD)</strong> · ERC-20 transfers
                </p>
                <p className="address">{wallet?.manifest.token}</p>
                <p>
                  {state === "enabled"
                    ? "Enabled · verified onchain"
                    : state === "ordinary"
                      ? "Off · your Safe currently has no spending limits"
                      : "Not verified"}
                </p>
                <dl>
                  <div>
                    <dt>One passkey</dt>
                    <dd>Up to 10 GLD in total instant spending today</dd>
                  </div>
                  <div>
                    <dt>Both passkeys</dt>
                    <dd>Over 10 and up to 30 GLD in total today</dd>
                  </div>
                  <div>
                    <dt>Above the daily limit</dt>
                    <dd>Queue with both passkeys · 120-second delay</dd>
                  </div>
                  <div>
                    <dt>Queued transfer expires</dt>
                    <dd>600 seconds after the delay</dd>
                  </div>
                </dl>
                <p className="small">
                  The onchain guard checks total instant spending for each
                  token. Any instant send that takes the daily total above 10
                  GLD requires both passkeys, from any wallet.
                </p>
                <label>
                  Approved GLD recipient
                  <input
                    value={recipient}
                    readOnly={state !== "ordinary" || !!record.recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                </label>
                <p className="small">
                  A distinct secondary passkey is required. It is not another
                  Safe owner. Separate credentials may still share a device or
                  sync account. Losing either factor can block future access.
                </p>
                {state === "ordinary" && (
                  <button disabled={busy} onClick={() => void run("enable")}>
                    {record.recipient
                      ? "Continue enabling tiered spending"
                      : "Enable protected GLD transfers"}
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
        {confirmation && <p role="status">{confirmation}</p>}
        {error && <p role="alert">{error}</p>}
        {record?.pending && (
          <p className="small">
            Pending operation:{" "}
            <span className="address">{record.pending.hash}</span>
          </p>
        )}
      </section>
      <footer>Local chain 31337 · Test GLD only.</footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
