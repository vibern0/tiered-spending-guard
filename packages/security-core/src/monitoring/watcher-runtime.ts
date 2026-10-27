import type { ActivityLedger } from "./ledger";
import { createWebhookNotifier, type Notifier, type ReadyNotifier, type WebhookFetch, type WebhookDeliveryEvidence } from "./notifier";

export function createLiveWebhookNotifier(environment:Readonly<Record<string,string|undefined>>,fetcher?:WebhookFetch):ReadyNotifier{
  const url=environment.MONITOR_WEBHOOK_URL;
  if(!url)throw new Error("missing MONITOR_WEBHOOK_URL");
  return createWebhookNotifier(url,fetcher);
}

export async function deliverPendingAlerts(ledger:ActivityLedger,notifier:Notifier):Promise<void>{
  for(const pending of ledger.pending()){
    const evidence=await notifier.notify(pending.alert);
    if(!evidence||evidence.channel!=="webhook")throw new Error("external webhook evidence required");
    ledger.markDelivered(pending.key,evidence as WebhookDeliveryEvidence);
  }
}

export async function scanFailClosed<T>(items:readonly T[],processItem:(item:T)=>Promise<void>,identify:(item:T)=>string):Promise<void>{
  for(const item of items){try{await processItem(item);}catch{throw new Error(`observer scan failed for ${identify(item)}`);}}
}
