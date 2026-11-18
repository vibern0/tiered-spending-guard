# Atomic Setup Helper Proposal

Date: 2026-09-29

Status: selected for the Option B atomic deployment transport prototype.

## Problem

Safe 1.5 `createProxyWithNonce` derives the proxy address from the initializer hash. The original atomic setup sketch placed the final Safe address inside the initializer so Zodiac Delay could enable the Safe as its upstream module during setup. That makes the address recursive: the Safe address depends on an initializer that itself contains the Safe address.

The selected design uses a reviewed, stateless setup helper as the Safe setup delegatecall target. During the delegatecall, `address(this)` is the new Safe proxy, so the helper can configure Delay and Safe self-authorized settings without embedding the Safe address in the initializer.

## Options

### Option 1: Reviewed Setup Helper

Pros:

1. Keeps one externally submitted Safe creation transaction: the Safe either initializes with primary passkey plus both secondary owners, guard slots, Delay module, Delay upstream module, maintenance, YubiKey secondary configuration, and policy, or creation reverts.
2. Removes the CREATE2 fixed-point problem because the initializer references the helper, guard, Delay, and maintenance addresses, but not the Safe address.
3. Keeps the deploy-time privileged code narrow and auditable: one stateless helper function with a fixed sequence of Safe-originated calls.

Cons:

1. Adds new custom Solidity in the security core, which requires adversarial tests, documentation, Slither review, and later independent audit before production use.
2. Uses Safe setup delegatecall deliberately, so storage writes in the helper would write Safe storage; the helper must remain stateless and avoid direct storage mutation.
3. Becomes another deployment dependency whose runtime code hash and address must be verified before any production plan can be considered safe.

### Option 2: Different Deployment Construction

Pros:

1. Could avoid custom setup code if a factory or salt scheme can derive the Safe address independently of initializer bytes.
2. Might keep the initializer on standard Safe/Zodiac primitives, reducing local contract audit burden.
3. Could produce cleaner offchain planning if all addresses are computed from stable salts rather than deployer nonce order.

Cons:

1. Requires changing deployment primitives or factory assumptions, which broadens dependency review and canonical-address evidence.
2. May conflict with pinned Safe 1.5 factory semantics or require a custom factory, moving risk from helper code into deployment infrastructure.
3. Still needs strong partial-deployment and nonce-drift proofs, and the final construction may be harder for a human reviewer to reproduce.

### Option 3: Staged Setup

Pros:

1. Uses familiar post-creation Safe transactions and avoids new delegatecall helper code in the initializer.
2. Makes each configuration operation individually inspectable before broadcast.
3. Is simpler to prototype locally because the Safe address exists before Delay upstream setup.

Cons:

1. Creates an interval where an asset-holding Safe may exist before all guards, module guards, Delay wiring, maintenance, and policy are complete.
2. Requires extra bootstrap authority or temporary permissions, which must then be proven removed and not reusable.
3. Weakens the plan's fail-closed deployment property because partial success can leave a live but incompletely protected Safe.

## Selected Design

Use `SafeAtomicSetupHelper.setup` as the `to` and `data` delegatecall payload passed to Safe `setup`.

Allowed sequence:

1. Configure each asset policy on `TieredSpendingGuard`.
2. Configure the YubiKey Safe-contract secondary on `TieredSpendingGuard`.
3. Set the one-time `GuardReplacementMaintenance` address on the guard.
4. Call Zodiac Delay `enableModule(address(this))`, where `address(this)` is the Safe proxy.
5. Safe self-call `setGuard(guard)`.
6. Safe self-call `setModuleGuard(guard)`.
7. Safe self-call `enableModule(delay)`.

The helper must:

- have no persistent storage variables;
- reject zero helper inputs and zero asset policy targets;
- reject missing, duplicate, or unbound Option B signer inputs;
- require guard, Delay, and maintenance code to exist before setup;
- only make the fixed calls above;
- never accept arbitrary target/calldata batches;
- never sign, authorize, relay, or persist secret material;
- revert the full Safe creation if any call fails.

## Deployment Planning Impact

Prerequisite addresses now use four contiguous deployer nonces:

1. setup helper;
2. guard;
3. Delay;
4. maintenance.

The Safe initializer references the helper address and setup data, but not the Safe address. The Safe proxy address can therefore be derived from `createProxyWithNonce` before generating guard, Delay, and maintenance creation code that binds to that Safe address.

Production planning remains Sepolia-only and fail-closed until the helper runtime hash, prerequisite runtime hashes, constructor bindings, official Safe dependencies, and deployer nonce are all verified from live reads.
