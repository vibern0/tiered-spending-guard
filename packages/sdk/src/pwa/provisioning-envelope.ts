const BPS = 10_000n;

export type PwaProvisioningEnvelopePolicy = Readonly<{
  gasMarginBps: bigint;
  feeMarginBps: bigint;
  maxEstimateDivergenceBps: bigint;
  maxTotalOutlayWei: bigint;
}>;

export type PwaProvisioningEnvelopeInput = Readonly<{
  estimates: readonly [bigint, bigint];
  blockGasLimit: bigint;
  baseFeePerGas: bigint;
  priorityFeesPerGas: readonly [bigint, bigint];
  value: bigint;
  confirmedActualCost: bigint;
  pendingReservation: bigint;
  relayBalance: bigint;
  policy: PwaProvisioningEnvelopePolicy;
}>;

export type PwaProvisioningEnvelope = Readonly<{
  gasEstimate: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  reservation: bigint;
  totalOutlay: bigint;
  requiredBalance: bigint;
}>;

function ceilBps(value: bigint, marginBps: bigint): bigint {
  if (value < 0n || marginBps < 0n) throw new Error("provisioning envelope value or margin is negative");
  return (value * (BPS + marginBps) + BPS - 1n) / BPS;
}

export function derivePwaProvisioningEnvelope(input: PwaProvisioningEnvelopeInput): PwaProvisioningEnvelope {
  const [leftEstimate, rightEstimate] = input.estimates;
  if (leftEstimate <= 0n || rightEstimate <= 0n) throw new Error("provisioning gas estimate must be positive");
  if (input.blockGasLimit <= 0n) throw new Error("provisioning block gas limit must be positive");
  if (input.baseFeePerGas < 0n) throw new Error("provisioning base fee is invalid");
  if (input.priorityFeesPerGas.some((value) => value < 0n)) throw new Error("provisioning priority fee is invalid");
  if (input.value < 0n) throw new Error("provisioning transaction value is invalid");
  if (input.confirmedActualCost < 0n || input.pendingReservation < 0n) throw new Error("provisioning accounting is invalid");
  if (input.relayBalance < 0n) throw new Error("provisioning relay balance is invalid");
  if (
    input.policy.gasMarginBps < 0n
    || input.policy.feeMarginBps < 0n
    || input.policy.maxEstimateDivergenceBps < 0n
    || input.policy.maxEstimateDivergenceBps > BPS
    || input.policy.maxTotalOutlayWei <= 0n
  ) throw new Error("provisioning envelope policy is invalid");

  const gasEstimate = leftEstimate > rightEstimate ? leftEstimate : rightEstimate;
  const lowerEstimate = leftEstimate < rightEstimate ? leftEstimate : rightEstimate;
  if ((gasEstimate - lowerEstimate) * BPS > gasEstimate * input.policy.maxEstimateDivergenceBps) throw new Error("provisioning gas estimates diverge");
  const gasLimit = ceilBps(gasEstimate, input.policy.gasMarginBps);
  if (gasLimit > input.blockGasLimit) throw new Error("provisioning gas limit exceeds canonical block gas limit");

  const observedPriorityFee = input.priorityFeesPerGas[0] > input.priorityFeesPerGas[1] ? input.priorityFeesPerGas[0] : input.priorityFeesPerGas[1];
  const maxPriorityFeePerGas = ceilBps(observedPriorityFee, input.policy.feeMarginBps);
  const maxFeePerGas = ceilBps(input.baseFeePerGas * 2n + observedPriorityFee, input.policy.feeMarginBps);
  if (maxPriorityFeePerGas > maxFeePerGas) throw new Error("provisioning priority fee exceeds maximum fee");

  const reservation = input.value + gasLimit * maxFeePerGas;
  const totalOutlay = input.confirmedActualCost + input.pendingReservation + reservation;
  if (totalOutlay > input.policy.maxTotalOutlayWei) throw new Error("provisioning phase outlay limit exceeded");
  const requiredBalance = input.pendingReservation + reservation;
  if (requiredBalance > input.relayBalance) throw new Error("provisioning relay balance is insufficient");

  return Object.freeze({ gasEstimate, gasLimit, maxFeePerGas, maxPriorityFeePerGas, reservation, totalOutlay, requiredBalance });
}
