/** Fixed backend-facing submission primitives; browser input remains a closed PWA intent. */
export { encodeGuardContractSignatures, type VerifiedContractApproval } from "../signers/guard-signatures";
export { canonicalSubmissionJson, snapshotPreparedPwaIntent, snapshotSubmissionRequest, submissionRequestHash } from "../transport/validate";
export { deploymentInfrastructureHash, validateAndBroadcast, type RelayerContext, type CanonicalReceipt } from "../transport/relayer";
export { encodeSafeExecutionCalldata, encodeDelayExecutionCalldata } from "../transport/calldata";
export type { PreparedPwaIntent, PreparedSignedPwaIntent, PreparedDirectPwaIntent, PwaQueueBinding, SimulationEvidence, SafeExecutionRequest, DelayExecutionRequest, SubmissionRequest, SubmissionResult } from "../transport/types";
export type { VerifiedDeploymentInfrastructure } from "../config/deployments";
export type { VaultPolicy, AssetSpendState } from "../config/policy";
export type { TopologyReport } from "../topology/verify";
export { queueFingerprint } from "../queue/delay";
export { acquireLocalWriterLease } from "../../scripts/live/runtime";
