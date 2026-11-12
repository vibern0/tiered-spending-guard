type FirstSignerUsage = Readonly<{
  spentInstant: bigint;
  policy: Readonly<{ firstSignerDaily: bigint }>;
}>;

export function displayedFirstSignerSpend(state: FirstSignerUsage): bigint {
  return state.spentInstant < state.policy.firstSignerDaily
    ? state.spentInstant
    : state.policy.firstSignerDaily;
}
