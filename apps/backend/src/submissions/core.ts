import * as namespace from "@tiered-spending-guard/security-core/pwa";
import { keccak256, stringToHex } from "viem";

export const core = (namespace as unknown as { default?: typeof namespace }).default ?? namespace;
export const bytes32 = /^0x[0-9a-fA-F]{64}$/;
export const hash = (value: unknown) => keccak256(stringToHex(core.canonicalSubmissionJson(value)));
