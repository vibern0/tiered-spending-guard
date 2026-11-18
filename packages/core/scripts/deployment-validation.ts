const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export const address = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`${path} must be a 20-byte hex address`);
  return value.toLowerCase();
};

export const hash = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${path} must be a 32-byte hex hash`);
  return value.toLowerCase();
};

export const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
};

export const exactKeys = (value: Record<string, unknown>, keys: readonly string[], path: string, optional: readonly string[] = []): void => {
  const allowed = new Set([...keys, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}.${key} is unknown`);
  for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key} is required${key === "expectedQueueFingerprints" || key === "setupTransactionHashes" ? "; evidence arrays must be explicit" : ""}`);
};
