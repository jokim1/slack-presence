import { describe, expect, it } from "vitest";
import { commandError, RateLimitError, ReauthError } from "./native-api";

describe("commandError", () => {
  it("maps Slack Retry-After into RateLimitError", () => {
    const error = commandError({ kind: "rateLimited", retryAfterSeconds: 42 });
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterSeconds).toBe(42);
  });

  it("maps revoked or expired tokens into ReauthError", () => {
    const error = commandError({
      kind: "reauth",
      message: "Slack authorization expired. Reconnect the workspace.",
    });
    expect(error).toBeInstanceOf(ReauthError);
    expect(error.message).toMatch(/Reconnect/);
  });

  it("keeps missing-scope and network messages as plain errors", () => {
    expect(
      commandError({
        kind: "message",
        message: "The Slack app is missing a required user scope. Update it and reconnect.",
      }).message,
    ).toMatch(/missing a required user scope/);
    expect(commandError({ message: "Could not reach Slack" }).message).toBe(
      "Could not reach Slack",
    );
  });

  it("parses a JSON string the same way as an object payload", () => {
    const error = commandError(
      JSON.stringify({ kind: "reauth", message: "Reconnect this Slack workspace" }),
    );
    expect(error).toBeInstanceOf(ReauthError);
    expect(error.message).toMatch(/Reconnect/);
  });
});
