# Static wallet

Create a Safe with a passkey. Open **Settings** on the same wallet to enable tiered spending with a second passkey. This demonstration uses Gold (GLD), an 18-decimal local mock ERC-20. In Settings, choose the approved recipient and enable protected GLD transfers. Send GLD from the wallet home. A primary passkey can spend 10 GLD per day. Both passkeys can spend up to 30 GLD per day combined. The instant Send form rejects amounts requiring Delay.

From the repository root, use Node 24 and the workspace lockfile.

```sh
pnpm install --frozen-lockfile
npm run wallet:dev
```

Open **http://localhost:5180** in a browser with passkeys. Keep the command running while using the wallet. Refreshing the page keeps the wallet address and checks its installation onchain. Stopping the command discards the local chain. A fresh browser profile gives a clean onboarding rehearsal.

The frontend ships as static files. The command starts Vite plus a disposable Hardhat fixture that supplies the RPC, bundler and paymaster for development. The fixture funds its own paymaster with test ETH and submits operations to EntryPoint 0.7. It uses fixed local gas estimates. Hosted bundler admission, public sponsorship, repair and independent alerts remain open research gates.

Each fresh fixture credits 1,000 GLD to `0x614f2F5011b9C329770576be59Ae294a6e7D9fdC`. Other newly created demo Safes receive 100 GLD. The fixture exposes the mock token address and code hash in its local manifest.

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

Wallet teams can use this flow to evaluate opt-in installation on a fresh Safe 1.5. The experimental guard profile is restricted to local test assets. See the [implementation plan](../../packages/core/docs/superpowers/plans/2026-11-20-static-wallet.md).

## Integration for wallet teams

1. Check eligibility onchain. The tested starting configuration is Safe 1.5.0, one credential-specific Safe passkey owner, threshold one, the pinned standard 4337 module as the only module and fallback, and both guard slots empty. Existing token approvals need separate review.
2. Ask the user to review the token, recipient, limits, delay and second credential. Use the existing owner to approve configuration of the per-Safe router, guard and Delay. Verify their code, bindings and policy.
3. Build the atomic installation with `buildSafe4337RouteInstall`. It swaps the fallback and module, enables Delay and sets both guard slots. Run `verifySafe4337RouteTopology` plus asset and signer checks before reporting activation. The same Safe holds the assets.
4. Update Send. Encode only the reviewed token’s `transfer`, bind signatures to the exact inner Safe transaction and obtain the outer SafeOp signature in the installed router’s domain. Submit via a compatible bundler/paymaster. Reconcile the EntryPoint event and read the chain after interruption.

The example has one reviewed ERC-20. Adding more contracts, different signer topologies, delayed policy changes or general contract interaction requires its own integration review. Public sponsorship, recovery, monitoring and audit gates remain open.
