# Wallet components

Screens consume `useVault()`; active balances, limits, recipients, signer status,
and freeze status come from the verified chain snapshot. Screens do not authorize
transactions or overwrite that snapshot with local edits.

## BottomSheet

Use `BottomSheet` from `./bottom-sheet` for app bottom sheets. It composes the
existing Radix dialog primitives, with one layout for the overlay, header, close
control, scrollable body, and optional fixed footer. Do not add screen-specific
portals or copies of this layout.

```tsx
<BottomSheet
  open={editing}
  onOpenChange={setEditing}
  title="Edit protection"
  description="Review changes before approval."
  footer={<PrimaryButton form="editor" type="submit">Review</PrimaryButton>}
>
  <form id="editor" onSubmit={reviewChanges}>{/* labelled fields */}</form>
</BottomSheet>
```

Every sheet needs a title and description. It traps focus, closes on Escape,
overlay click, or the labelled close button, and returns focus to its opener.
The first enabled input/select/textarea receives initial focus; otherwise Radix
focuses the first control. Body scrolling keeps the footer visible on small
screens; its padding includes the device safe area. State, validation, mutation,
and error handling stay with the caller. Render the controlled component beside
its opener so draft input survives closing/reopening it.

## ProtectionEditor

`ProtectionEditor` owns an **unsigned, in-memory draft**, validated by
`lib/protection-draft.ts`. It exposes both per-transfer caps, both daily limits,
the exact waiting period in seconds, recipients, proposed signer replacements,
and freeze state. USDC values preserve all six decimals using bigint arithmetic.
The Limits screen keeps displaying active onchain values beneath the sheet.
Chain snapshot changes remount the editor, discarding stale drafts.

**Integration boundary:** the existing transfer backend and its HTTP
contract do not define a settings-change API. This editor can review a proposal;
it cannot apply one. The review explicitly says "Draft only — not applied".
No local success, optimistic active-policy update, fabricated transaction,
settings HTTP endpoint, or new signing path is added by this UI work.

Connecting submission requires a separately verified backend contract that
prepares exact Safe transactions, binds current signer identities/nonce/policy,
obtains both required approvals, and enforces delayed weakening onchain. Limit
increases, recipient additions, signer rotation, unfreezing, and shorter delays
must retain the **current** mandatory delay. Only onchain-proven tightening may
be immediate. Add call-graph documentation and adversarial tests before adding
that execution path.

## Navigation and account access

`AppShell` gates every nested route until stored account configuration is loaded.
Without an account, it redirects to onboarding and never mounts account screens
or navigation. An existing account remains accessible during RPC failure; write
availability still comes from chain health checks. Home, Activity, and Limits
are the only main tabs. `/profile` redirects home for old bookmarks; none of its
former content or notification preferences is migrated elsewhere.
