import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./native-api";
import { cadenceForMemberCount, PresenceScheduler, PresenceStateCache } from "./presence-scheduler";

describe("cadenceForMemberCount", () => {
  it("sweeps small channels once a minute", () => {
    expect(cadenceForMemberCount(20)).toEqual({
      cycleMs: 60_000,
      requestSpacingMs: 3_000,
      staleNotice: false,
    });
  });

  it("gives medium channels a 90 second sweep", () => {
    expect(cadenceForMemberCount(50)).toEqual({
      cycleMs: 90_000,
      requestSpacingMs: 1_800,
      staleNotice: false,
    });
  });

  it("caps rolling refreshes at 40 calls per minute", () => {
    expect(cadenceForMemberCount(120)).toEqual({
      cycleMs: 180_000,
      requestSpacingMs: 1_500,
      staleNotice: false,
    });
  });

  it("marks very large channel presence as potentially stale", () => {
    expect(cadenceForMemberCount(400)).toEqual({
      cycleMs: 600_000,
      requestSpacingMs: 1_500,
      staleNotice: true,
    });
  });
});

describe("PresenceStateCache", () => {
  it("reports only actual presence changes", () => {
    const cache = new PresenceStateCache();
    expect(cache.update("U1", "away")).toBe(true);
    expect(cache.update("U1", "away")).toBe(false);
    expect(cache.update("U1", "active")).toBe(true);
  });
});

describe("RateLimitError", () => {
  it("carries Slack Retry-After for the real presence path", () => {
    const error = new RateLimitError(27);
    expect(error).toBeInstanceOf(Error);
    expect(error.retryAfterSeconds).toBe(27);
    expect(error.message).toMatch(/27 seconds/);
  });
});

describe("PresenceScheduler workspace switch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not carry Retry-After backoff into a new start()", async () => {
    const calls: string[] = [];
    let failFirst = true;
    const scheduler = new PresenceScheduler({
      request: async (userId) => {
        calls.push(userId);
        if (failFirst) {
          failFirst = false;
          throw new RateLimitError(60);
        }
        return { userId, presence: "active" };
      },
      onChange: () => undefined,
      onRateLimit: () => undefined,
      onError: () => undefined,
    });

    scheduler.start(["UAAAAAAA"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["UAAAAAAA"]);

    scheduler.start(["UBBBBBBB"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toContain("UBBBBBBB");
    scheduler.stop();
  });
});
