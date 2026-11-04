import { expect } from "chai";
import {
  derivePwaProvisioningEnvelope,
  type PwaProvisioningEnvelopeInput,
} from "../../../src/pwa/provisioning-envelope";

const base = (overrides: Partial<PwaProvisioningEnvelopeInput> = {}): PwaProvisioningEnvelopeInput => ({
  estimates: [6_593_635n, 6_593_635n],
  blockGasLimit: 100_000_000n,
  baseFeePerGas: 22n,
  priorityFeesPerGas: [3n, 2n],
  value: 0n,
  confirmedActualCost: 1_000n,
  pendingReservation: 2_000n,
  relayBalance: 1_000_000_000n,
  policy: {
    gasMarginBps: 3000n,
    feeMarginBps: 3000n,
    maxEstimateDivergenceBps: 1000n,
    maxTotalOutlayWei: 50_000_000_000_000_000n,
  },
  ...overrides,
});

describe("PWA provisioning transaction envelope", () => {
  it("uses the higher estimate and exact 30 percent ceiling arithmetic", () => {
    const envelope = derivePwaProvisioningEnvelope(base());

    expect(envelope.gasLimit).to.equal(8_571_726n);
    expect(envelope.maxPriorityFeePerGas).to.equal(4n);
    expect(envelope.maxFeePerGas).to.equal(62n);
    expect(envelope.reservation).to.equal(531_447_012n);
  });

  it("accepts exactly ten percent estimate divergence and rejects more", () => {
    expect(() => derivePwaProvisioningEnvelope(base({ estimates: [90n, 100n] }))).not.to.throw();
    expect(() => derivePwaProvisioningEnvelope(base({ estimates: [89n, 100n] }))).to.throw(/diverg/i);
  });

  it("rejects a padded gas limit above the canonical block gas limit", () => {
    expect(() => derivePwaProvisioningEnvelope(base({ estimates: [100n, 100n], blockGasLimit: 129n }))).to.throw(/block gas/i);
  });

  it("checks cumulative spend against policy but only outstanding reservations against balance", () => {
    const smallPolicy = { ...base().policy, maxTotalOutlayWei: 10_000n };
    expect(() => derivePwaProvisioningEnvelope(base({
      estimates: [10n, 10n],
      baseFeePerGas: 1n,
      priorityFeesPerGas: [0n, 0n],
      confirmedActualCost: 9_970n,
      pendingReservation: 0n,
      relayBalance: 1_000n,
      policy: smallPolicy,
    }))).to.throw(/outlay/i);

    const envelope = derivePwaProvisioningEnvelope(base({
      estimates: [10n, 10n],
      baseFeePerGas: 1n,
      priorityFeesPerGas: [0n, 0n],
      confirmedActualCost: 9_000n,
      pendingReservation: 100n,
      relayBalance: 200n,
      policy: smallPolicy,
    }));
    expect(envelope.totalOutlay).to.equal(9_139n);
    expect(envelope.requiredBalance).to.equal(139n);
  });

  it("rejects zero, negative, invalid fee, budget, and balance inputs", () => {
    expect(() => derivePwaProvisioningEnvelope(base({ estimates: [0n, 1n] }))).to.throw(/estimate/i);
    expect(() => derivePwaProvisioningEnvelope(base({ baseFeePerGas: -1n }))).to.throw(/fee/i);
    expect(() => derivePwaProvisioningEnvelope(base({ priorityFeesPerGas: [-1n, 0n] }))).to.throw(/priority/i);
    expect(() => derivePwaProvisioningEnvelope(base({ value: -1n }))).to.throw(/value/i);
    expect(() => derivePwaProvisioningEnvelope(base({ relayBalance: 0n }))).to.throw(/balance/i);
  });
});
