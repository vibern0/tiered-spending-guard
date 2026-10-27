import { expect } from "chai";
import { getAddress } from "viem";
import { ActivityLedger, InMemoryActivityStore, type ActivityLogKey } from "../../../src/monitoring/ledger";
import { createLiveWebhookNotifier, deliverPendingAlerts, scanFailClosed } from "../../../src/monitoring/watcher-runtime";
import type { ActivityAlert, Notifier, WebhookFetch } from "../../../src/monitoring/notifier";

const alert:ActivityAlert={kind:"step-up-executed",chainId:31337,safe:getAddress("0x0000000000000000000000000000000000000001"),guard:getAddress("0x0000000000000000000000000000000000000002"),transactionHash:`0x${"01".padStart(64,"0")}`,blockNumber:10n,logIndex:0,token:getAddress("0x0000000000000000000000000000000000000004"),recipient:getAddress("0x0000000000000000000000000000000000000005"),amount:25n,baseSpent:7n,instantSpent:25n,window:1n};
const key:ActivityLogKey={chainId:31337,blockHash:`0x${"10".padStart(64,"0")}`,transactionHash:alert.transactionHash,logIndex:0};

describe("activity watcher fail-closed composition",()=>{
  it("requires a valid external webhook before observer scanning",()=>{
    expect(()=>createLiveWebhookNotifier({})).to.throw(/MONITOR_WEBHOOK_URL/);
    expect(()=>createLiveWebhookNotifier({MONITOR_WEBHOOK_URL:"http://localhost/hook"})).to.throw(/HTTPS|public/);
  });

  it("rejects DNS-private readiness before observer scanning or ledger mutation",async()=>{
    const ledger=new ActivityLedger(new InMemoryActivityStore());
    let scanned=false;
    const fetcher=Object.assign(async()=>({ok:true,status:204}),{ready:async()=>{throw new Error("webhook URL must resolve only to public addresses");}}) as WebhookFetch;
    const notifier=createLiveWebhookNotifier({MONITOR_WEBHOOK_URL:"https://example.invalid/hook"},fetcher);
    const run=async()=>{await notifier.ready();scanned=true;ledger.accept(key,alert);};
    await expect(run()).to.be.rejectedWith(/public/);
    expect(scanned).to.equal(false);
    expect(ledger.records()).to.have.length(0);
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

  it("keeps successful earlier work and stops before later cursor advancement when a relevant item fails",async()=>{
    const completed:number[]=[];
    await expect(scanFailClosed([1,2,3],async value=>{if(value===2)throw new Error("wrong digest");completed.push(value);},value=>`log-${value}`)).to.be.rejectedWith(/observer scan failed.*log-2/i);
    expect(completed).to.deep.equal([1]);
  });

  it("retries the failed ordered item before accepting a later item after restart",async()=>{
    const store=new InMemoryActivityStore();
    const first=new ActivityLedger(store);
    const make=(blockNumber:bigint,logIndex:number):[ActivityLogKey,ActivityAlert]=>{
      const transactionHash=`0x${blockNumber.toString(16).padStart(64,"0")}` as `0x${string}`;
      return [{...key,blockHash:`0x${(blockNumber+100n).toString(16).padStart(64,"0")}`,transactionHash,logIndex},{...alert,transactionHash,blockNumber,logIndex}];
    };
    const items=[make(10n,0),make(11n,0),make(12n,0)] as const;
    await expect(scanFailClosed(items,async ([itemKey,itemAlert])=>{if(itemAlert.blockNumber===11n)throw new Error("malformed expected event");first.accept(itemKey,itemAlert);},([,itemAlert])=>`block-${itemAlert.blockNumber}`)).to.be.rejectedWith(/block-11/);
    expect(first.records().map(record=>record.blockNumber)).to.deep.equal([10n]);
    expect(first.cursor()?.blockNumber).to.equal(10n);

    const restarted=new ActivityLedger(store);
    await scanFailClosed(items.slice(1),async ([itemKey,itemAlert])=>{restarted.accept(itemKey,itemAlert);},([,itemAlert])=>`block-${itemAlert.blockNumber}`);
    expect(restarted.records().map(record=>record.blockNumber)).to.deep.equal([10n,11n,12n]);
    expect(restarted.cursor()?.blockNumber).to.equal(12n);
  });

  it("rejects arbitrary proposer-shaped bodies before persistence or delivery",()=>{
    const ledger=new ActivityLedger(new InMemoryActivityStore());
    expect(()=>ledger.accept(key,{...alert,privateKey:"arbitrary"} as never)).to.throw(/unknown|sensitive/i);
    expect(ledger.pending()).to.have.length(0);
  });
});
