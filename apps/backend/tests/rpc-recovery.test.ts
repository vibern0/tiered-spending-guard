import { EstimateGasExecutionError, ResourceNotFoundRpcError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeRpc } from "../src/provisioner";

afterEach(() => vi.useRealTimers());

describe("bounded provisioning RPC read recovery", () => {
  it("retries a read when viem wraps a resource-not-found error inside gas estimation", async () => {
    vi.useFakeTimers();
    const cause = new ResourceNotFoundRpcError(new Error("private RPC request"));
    const wrapped = new EstimateGasExecutionError(cause, {});
    const read = vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce(123n);
    const result = sanitizeRpc("identity provider 1", "estimateGas", read, true).then(value => ({ value }), error => ({ error }));
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ value: 123n });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not retry writes even when a caller accidentally enables read recovery", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new ResourceNotFoundRpcError(new Error("unknown outcome")));
    const result = sanitizeRpc("relay", "sendRawTransaction", send, true);
    const assertion = expect(result).rejects.toThrow(/Sepolia RPC request failed/);
    await vi.runAllTimersAsync(); await assertion;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated failures and reports only cause categories, never RPC bodies or signatures", async () => {
    vi.useFakeTimers();
    const cause = Object.assign(new Error("https://secret.invalid/token request signature 0x" + "ab".repeat(96)), { name: "ResourceNotFoundRpcError", code: -32001 });
    const wrapped = Object.assign(new Error("secret outer payload"), { name: "EstimateGasExecutionError", cause });
    const read = vi.fn().mockRejectedValue(wrapped);
    const result = sanitizeRpc("identity provider 1", "estimateGas", read, true);
    let error: Error | undefined;
    const caught = result.catch(value => { error = value; });
    await vi.runAllTimersAsync(); await caught;
    expect(read).toHaveBeenCalledTimes(2);
    expect(error?.message).toContain("EstimateGasExecutionError");
    expect(error?.message).toContain("ResourceNotFoundRpcError");
    expect(error?.message).not.toMatch(/secret|https|signature|ababab/);
  });

  it("retries the exact historical-state-unavailable nonce read without changing its request", async () => {
    vi.useFakeTimers();
    const unavailable = Object.assign(new Error("historical state " + "ab".repeat(32) + " is not available"), { name: "InvalidInputRpcError", code: -32000 });
    const read = vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce(1069);
    const result = sanitizeRpc("identity provider 1", "getTransactionCount", read, true).then(value => ({ value }), error => ({ error }));
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ value: 1069 });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bounds unavailable historical reads and never retries generic invalid input", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(Object.assign(new Error("historical state " + "ab".repeat(32) + " is not available"), { name: "InvalidInputRpcError", code: -32000 }));
    const caught = sanitizeRpc("identity provider 1", "getTransactionCount", read, true).catch(error => error);
    await vi.runAllTimersAsync();
    const failure = await caught;
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").not.toContain("abab");
    expect(read).toHaveBeenCalledTimes(4);
    const invalid = vi.fn().mockRejectedValue(Object.assign(new Error("invalid input"), { name: "InvalidInputRpcError", code: -32000 }));
    await expect(sanitizeRpc("identity provider 1", "getTransactionCount", invalid, true)).rejects.toThrow(/InvalidInputRpcError/);
    expect(invalid).toHaveBeenCalledTimes(1);
  });

  it("never retries a contract execution failure", async () => {
    const read = vi.fn().mockRejectedValue(Object.assign(new Error("contract reverted"), { name: "EstimateGasExecutionError", cause: Object.assign(new Error("revert"), { name: "ExecutionRevertedError", code: 3 }) }));
    await expect(sanitizeRpc("identity provider 1", "estimateGas", read, true)).rejects.toThrow(/ExecutionRevertedError/);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
