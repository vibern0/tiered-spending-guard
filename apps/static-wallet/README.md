# Static wallet

Create a Safe with a passkey. Open **Settings** on the same wallet to enable tiered spending with a second passkey. This demonstration uses a disposable local chain and test ETH.

From the repository root, use Node 24 and the workspace lockfile.

```sh
pnpm install --frozen-lockfile
npm run wallet:dev
```

Open **http://localhost:5180** in a browser with passkeys. Keep the command running while using the wallet. Refreshing the page keeps the wallet address and checks its installation onchain. Stopping the command discards the local chain. A fresh browser profile gives a clean onboarding rehearsal.

The frontend ships as static files. The command starts Vite plus a disposable Hardhat fixture that supplies the RPC, bundler and paymaster for development. The fixture funds its own paymaster with test ETH and submits operations to EntryPoint 0.7. It uses fixed local gas estimates. Hosted bundler admission, public sponsorship, repair and independent alerts remain open research gates.

With the local fixture running, build the static files in another terminal.

```sh
npm --prefix apps/static-wallet run build
```

To rehearse the interface with virtual passkeys, install Chromium for the pinned browser test driver and run the smoke test. It interrupts sponsorship between preparation and activation, refreshes the app, and verifies the final guard slots and sponsored receipts onchain.

```sh
cd apps/static-wallet
./node_modules/.bin/playwright-core install chromium
npm run smoke
```

Wallet teams can use this flow to evaluate opt-in installation on a fresh Safe 1.5. The experimental guard profile is restricted to unfunded local wallets. See the [implementation plan](../../packages/core/docs/superpowers/plans/2026-11-20-static-wallet.md).
