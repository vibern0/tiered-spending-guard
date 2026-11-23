import { useEffect, useState } from "react";
import { dayStart } from "./transfer";
import type { Wallet, WalletRecord } from "./wallet";

type Snapshot = Awaited<ReturnType<Wallet["spending"]>> & { now: bigint };
export function useSpending(
  wallet: Wallet | undefined,
  record: WalletRecord | null,
  active: boolean,
) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(undefined);
    setProblem("");
    if (!wallet || !record || !active) return;
    const w = wallet,
      r = record;
    let components: Awaited<ReturnType<Wallet["components"]>> | undefined;
    let previous = "",
      values: Awaited<ReturnType<Wallet["spending"]>>;
    async function poll() {
      try {
        components ??= await w.components(r);
        const [block, pending] = await Promise.all([
          w.client.getBlock(),
          w.client.getBlock({ blockTag: "pending" }),
        ]);
        const key = `${block.hash}/${dayStart(pending.timestamp)}`;
        if (previous !== key) {
          values = await w.spending(
            r,
            components.guard.address,
            components.delay.address,
            block.number,
            pending.timestamp,
          );
          previous = key;
        }
        if (!stopped) {
          setSnapshot({ ...values, now: pending.timestamp });
          setProblem("");
        }
      } catch {
        previous = "";
        if (!stopped) {
          setSnapshot(undefined);
          setProblem("Could not verify spending and queue data. Retrying…");
        }
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [wallet, record, active]);
  return { snapshot, problem };
}
