# Static wallet

Create a Safe with a passkey. Open **Settings** on the same wallet to enable tiered spending with a second passkey. This demonstration uses Gold (GLD), an 18-decimal local mock ERC-20. In Settings, choose the approved recipient and enable protected GLD transfers. Send GLD from the wallet home. A primary passkey can spend 10 GLD per day. Both passkeys can spend up to 30 GLD per day combined. When a send would take instant spending over 30 GLD, the button changes to **Queue GLD**. Approve the full payment with both passkeys. The recipient receives GLD only when you execute the withdrawal.

For instant GLD sends, queue requests and cancellations, the browser finalizes sponsorship first. Every required passkey signs the same operation once. A send of 1 GLD and then 9.1 GLD takes three assertions in total. Queuing 20 GLD after those sends takes two assertions, one from each passkey. Browser tests count credential requests and authenticator events and check their credential IDs.

The wallet applies both thresholds to the same UTC day's total instant spending. Sending 1 GLD shows 1 / 10 GLD and 1 / 30 GLD. Sending another 9.1 GLD requires both passkeys and shows 10 / 10 GLD and 10.1 / 30 GLD. Further instant sends from this wallet require both passkeys until the daily reset. Delayed withdrawals are shown separately.

The updated ERC-4337 guard enforces both thresholds against the same onchain instant total, including submissions from other clients. The primary-only counter records how much was actually sent with one passkey. Older guard deployments keep their original policy. A separate local chain can recreate the same Safe address with the original owner and fresh balances and spending counters. Enable protection in Settings on that chain.

The withdrawal queue survives a page refresh. Cancel the oldest item with one approval from each passkey. Both approve its queue number, token, amount and recipient in one sponsored operation. A changed head requires a fresh review. Choose **Execute withdrawal** after 120 seconds and confirm the sponsored submission with the primary passkey. The execution window lasts 600 seconds. Clear an expired head with **Cancel withdrawal** to reach the next item.

From the repository root, use Node 24 and the workspace lockfile.

```sh
pnpm install --frozen-lockfile
STATIC_WALLET_RPC_PORT=8555 STATIC_WALLET_UI_PORT=5189 npm run wallet:dev
```

Open **http://localhost:5189** in a browser with passkeys. Keep the command running while using the wallet. Refreshing the page keeps the wallet address and checks its installation onchain. Stopping the command discards the local chain. A fresh browser profile gives a clean onboarding rehearsal.

The frontend ships as static files. The command starts Vite plus a disposable Hardhat fixture that supplies the RPC, bundler and paymaster for development. The fixture funds its own paymaster with test ETH and submits operations to EntryPoint 0.7. It uses fixed local gas estimates. Hosted bundler admission, public sponsorship, repair and independent alerts remain open research gates.

Each fresh fixture credits 1,000 GLD to `0x614f2F5011b9C329770576be59Ae294a6e7D9fdC`. Other newly created demo Safes receive 100 GLD. The fixture exposes the mock token address and code hash in its local manifest.

With the local fixture running, build the static files in another terminal.

```sh
npm --prefix apps/static-wallet run build
```

## End-to-end wallet test

From the repository root, install the pinned Chromium browser once, then run the wallet test:

```sh
pnpm --filter @tiered-spending-guard/static-wallet exec playwright install chromium
npm run wallet:test
```

Playwright starts a fresh local Hardhat chain, bundler, paymaster and wallet UI for each run. It uses dedicated loopback ports (18547 for RPC and 15180 for the UI) and an isolated browser context with two virtual WebAuthn credentials. The runner shuts down its servers on exit. Allow about two minutes for the real withdrawal cooldown.

The scenario creates a Safe, enables protection in Settings, sends 1 GLD and then 9.1 GLD, and queues two identical 20 GLD withdrawals. It reloads the page, cancels only the first entry, then executes the second after 120 seconds. It checks passkey requests and assertions by credential, both guard slots, the daily meters, token balances, block timestamps and paymaster charges.

Wallet teams can use this flow to evaluate opt-in installation on a fresh Safe 1.5. The experimental guard profile is restricted to local test assets. See the [implementation plan](../../packages/core/docs/superpowers/plans/2026-11-20-static-wallet.md).

## Integration for wallet teams

1. Check eligibility onchain. The tested starting configuration is Safe 1.5.0, one credential-specific Safe passkey owner, threshold one, the pinned standard 4337 module as the only module and fallback, and both guard slots empty. Existing token approvals need separate review.
2. Ask the user to review the token, recipient, limits, delay and second credential. Use the existing owner to approve configuration of the per-Safe router, guard and Delay. Verify their code, bindings and policy.
3. Build the atomic installation with `buildSafe4337RouteInstall`. It swaps the fallback and module, enables Delay and sets both guard slots. Run `verifySafe4337RouteTopology` plus asset and signer checks before reporting activation. The same Safe holds the assets.
4. Update Send. For an instant GLD send, encode the pinned guard, token, recipient, amount, tier and expiry in the EntryPoint full-operation call. Sign the versioned router digest with every required credential after finalizing sponsorship. For a delayed proposal, use the guarded inner Safe transaction and outer SafeOp. Submit via a compatible bundler/paymaster. Reconcile the EntryPoint event and read the chain after interruption.

The example has one reviewed ERC-20. Adding more contracts, different signer topologies, delayed policy changes or general contract interaction requires its own integration review. Public sponsorship, recovery, monitoring and audit gates remain open.
