import { expect } from "chai";
import { getAddress } from "viem";
import { ActivityLedger, InMemoryActivityStore, type ActivityLogKey } from "../../../src/monitoring/ledger";
import { createLiveWebhookNotifier, deliverPendingAlerts, scanFailClosed } from "../../../src/monitoring/watcher-runtime";
import type { ActivityAlert, Notifier } from "../../../src/monitoring/notifier";

const alert:ActivityAlert={kind:"step-up-executed",chainId:31337,safe:getAddress("0x0000000000000000000000000000000000000001"),guard:getAddress("0x0000000000000000000000000000000000000002"),transactionHash:`0x${"01".padStart(64,"0")}`,blockNumber:10n,logIndex:0,token:getAddress("0x0000000000000000000000000000000000000004"),recipient:getAddress("0x0000000000000000000000000000000000000005"),amount:25n,baseSpent:7n,instantSpent:25n,window:1n};
const key:ActivityLogKey={chainId:31337,blockHash:`0x${"10".padStart(64,"0")}`,transactionHash:alert.transactionHash,logIndex:0};

describe("activity watcher fail-closed composition",()=>{
  it("requires a valid external webhook before observer scanning",()=>{
    expect(()=>createLiveWebhookNotifier({})).to.throw(/MONITOR_WEBHOOK_URL/);
    expect(()=>createLiveWebhookNotifier({MONITOR_WEBHOOK_URL:"http://localhost/hook"})).to.throw(/HTTPS|public/);
  });

  it("leaves a persisted alert pending when notification fails or lacks webhook evidence",async()=>{
    const ledger=new ActivityLedger(new InMemoryActivityStore());ledger.accept(key,alert);
    const failed:Notifier={notify:async()=>{throw new Error("offline");}};
    await expect(deliverPendingAlerts(ledger,failed)).to.be.rejectedWith(/offline/);
    expect(ledger.pending()).to.have.length(1);
    const stdoutOnly:Notifier={notify:async()=>undefined};
    await expect(deliverPendingAlerts(ledger,stdoutOnly)).to.be.rejectedWith(/webhook evidence/i);
    expect(ledger.pending()).to.have.length(1);
  });

  it("keeps successful earlier work but returns a failed scan when a relevant item is unverifiable",async()=>{
    const completed:number[]=[];
    await expect(scanFailClosed([1,2,3],async value=>{if(value===2)throw new Error("wrong digest");completed.push(value);},value=>`log-${value}`)).to.be.rejectedWith(/observer scan failed.*log-2/i);
    expect(completed).to.deep.equal([1,3]);
  });

  it("rejects arbitrary proposer-shaped bodies before persistence or delivery",()=>{
    const ledger=new ActivityLedger(new InMemoryActivityStore());
    expect(()=>ledger.accept(key,{...alert,privateKey:"arbitrary"} as never)).to.throw(/unknown|sensitive/i);
    expect(ledger.pending()).to.have.length(0);
  });
});
