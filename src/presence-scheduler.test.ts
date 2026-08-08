import { describe, expect, it } from "vitest";
import { cadenceForMemberCount, PresenceStateCache } from "./presence-scheduler";

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
