import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubmissionStatus } from "./vault-store";
import { useSubmissionStatuses } from "./use-submission-statuses";

const HASH = `0x${"12".repeat(32)}` as const;
const IDS = ["__proto__", "constructor", "toString"] as const;
const pending = (id: string): SubmissionStatus => ({
  id,
  state: "uncertain",
  transactionHash: HASH,
});
const confirmed = (id: string): SubmissionStatus => ({
  id,
  state: "confirmed",
  transactionHash: HASH,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("submission IDs that match inherited object names", () => {
  it.each(IDS)("polls restored %s through terminal state and stops", async (id) => {
    const read = vi.fn(async () => pending(id));
    const onTerminal = vi.fn(async () => {});
    const options = {
      scope: "account",
      enabled: true,
      ids: [id],
      read,
      isCurrent: () => true,
      onTerminal,
      isCovered: () => false,
    };
    const { result } = renderHook(() => useSubmissionStatuses(options));

    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(result.current.submissions[id]).toEqual(pending(id));
    expect(Object.hasOwn(result.current.submissions, id)).toBe(true);
    expect(read).toHaveBeenCalledWith(id);
    read.mockResolvedValue(confirmed(id));

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(result.current.submissions[id]).toEqual(confirmed(id));
    expect(onTerminal).toHaveBeenCalledTimes(1);
    const terminalReadCount = read.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(read).toHaveBeenCalledTimes(terminalReadCount);
  });

  it.each(IDS)("publishes observed %s without prototype writes", async (id) => {
    const options = {
      scope: "account",
      enabled: true,
      ids: [],
      read: async (key: string) => confirmed(key),
      isCurrent: () => true,
      onTerminal: vi.fn(async () => {}),
      isCovered: () => false,
    };
    const { result } = renderHook(() => useSubmissionStatuses(options));
    expect(result.current.submissions[id]).toBeUndefined();

    await act(async () => result.current.observeSubmission(pending(id)));
    expect(result.current.submissions[id]).toEqual(pending(id));
    expect(Object.hasOwn(result.current.submissions, id)).toBe(true);
    expect(result.current.submissions["transactionHash"]).toBeUndefined();

    await act(async () => {
      await result.current.readSubmission(id);
    });
    expect(result.current.submissions[id]).toEqual(confirmed(id));
    expect(options.onTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not expose inherited statuses after changing account scope or disabling tracking", () => {
    const options = {
      scope: "first",
      enabled: true,
      ids: [],
      read: async (id: string) => pending(id),
      isCurrent: () => true,
      onTerminal: async () => {},
      isCovered: () => false,
    };
    const { result, rerender } = renderHook(
      ({ scope, enabled }) => useSubmissionStatuses({ ...options, scope, enabled }),
      { initialProps: { scope: "first", enabled: true } },
    );
    rerender({ scope: "second", enabled: true });
    for (const id of IDS) expect(result.current.submissions[id]).toBeUndefined();
    rerender({ scope: "second", enabled: false });
    for (const id of IDS) expect(result.current.submissions[id]).toBeUndefined();
  });
});
