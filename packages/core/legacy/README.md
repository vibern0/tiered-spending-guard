# Historical prototype

This directory preserves the 2024 `RecentTransactionGuard` experiment for historical reference and negative-test material only. It is not a production foundation and is excluded from the active Hardhat source and test paths.

The historical guard has disabled authorization, is not bound to a specific transaction, has no spending limits, and has no withdrawal queue or cancellation flow. `GnosisSafeMock` is permissive and does not reproduce Safe authorization or signatures. Its tests are not security evidence.

Do not deploy, extend, or cite this prototype as evidence for the security-core design. New implementation work belongs in the active `contracts/`, `src/`, and `test/` trees and must follow the approved plan.
