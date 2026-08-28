import { describe, expect, it } from "vitest";
import { emptyCopy, settingsCopy, workspaceLabel } from "./connection-state";
import type { AppStatus, WorkspaceStatus } from "./types";

const unconfigured: AppStatus = {
  credentialsConfigured: false,
  hostedOAuthReady: false,
  clientId: "",
  hasClientSecret: false,
  exchangeUrl: "https://presence-for-slack-oauth.workers.dev/oauth/exchange",
  oauthInProgress: false,
  workspaces: [],
  activeTeamId: null,
  alwaysOnTop: false,
  redirectUri:
    "https://presence-for-slack-oauth.jokim1.workers.dev/oauth/callback",
};

const hosted: AppStatus = {
  ...unconfigured,
  credentialsConfigured: true,
  hostedOAuthReady: true,
  clientId: "123.456",
};

const byo: AppStatus = {
  ...unconfigured,
  credentialsConfigured: true,
  hostedOAuthReady: false,
  clientId: "123.456",
  hasClientSecret: true,
  redirectUri: "http://127.0.0.1:53641/oauth/callback",
};

const liveWorkspace: WorkspaceStatus = {
  teamId: "T123ABCDE",
  teamName: "Acme Studio",
  connected: true,
  selectedChannelId: "C123ABCDE",
};

const staleWorkspace: WorkspaceStatus = {
  ...liveWorkspace,
  connected: false,
};

describe("settingsCopy", () => {
  it("hides connect in the browser preview instead of showing a dead button", () => {
    const copy = settingsCopy(hosted, undefined, false);
    expect(copy.connectHidden).toBe(true);
    expect(copy.logoutHidden).toBe(true);
    expect(copy.connectionNote).toMatch(/macOS desktop app/);
  });

  it("opens the credentials form when the shared app is not configured", () => {
    const copy = settingsCopy(unconfigured, undefined, true);
    expect(copy.connectHidden).toBe(false);
    expect(copy.advancedOpen).toBe(true);
    expect(copy.connectionNote).not.toMatch(/\.env/);
    expect(copy.connectionNote).toMatch(/not set up/i);
    expect(copy.connectionNote).toMatch(/boxes below/);
    expect(copy.credentialsNote).toMatch(/api\.slack\.com\/apps/);
    expect(copy.credentialsNote).toMatch(/SETUP\.md/);
  });

  it("enables one-click connect when hosted OAuth is ready", () => {
    const copy = settingsCopy(hosted, undefined, true);
    expect(copy.connectHidden).toBe(false);
    expect(copy.connectDisabled).toBe(false);
    expect(copy.connectLabel).toBe("Connect Slack");
    expect(copy.advancedOpen).toBe(false);
    expect(copy.connectionNote).toMatch(/browser/);
    expect(copy.connectionNote).not.toMatch(/demo/i);
  });

  it("enables connect after BYO credentials are saved without a restart", () => {
    const copy = settingsCopy(byo, undefined, true);
    expect(copy.connectHidden).toBe(false);
    expect(copy.connectDisabled).toBe(false);
    expect(copy.advancedOpen).toBe(true);
  });

  it("reuses a live workspace instead of offering Connect again", () => {
    const copy = settingsCopy(hosted, liveWorkspace, true);
    expect(copy.modeLabel).toBe("Acme Studio");
    expect(copy.connectHidden).toBe(true);
    expect(copy.logoutHidden).toBe(false);
    expect(copy.logoutLabel).toBe("Disconnect Acme Studio");
    expect(copy.connectionNote).toMatch(/Keychain/);
  });

  it("offers reconnect for a workspace whose token is gone", () => {
    const copy = settingsCopy(hosted, staleWorkspace, true);
    expect(copy.connectionNote).toMatch(/reconnected/);
    expect(copy.connectHidden).toBe(false);
    expect(copy.connectLabel).toBe("Reconnect Slack");
  });

  it("shows cancel and hides connect while OAuth is pending", () => {
    const copy = settingsCopy({ ...hosted, oauthInProgress: true }, undefined, true);
    expect(copy.connectHidden).toBe(true);
    expect(copy.cancelHidden).toBe(false);
    expect(copy.connectionNote).toMatch(/on its own/);
  });
});

describe("emptyCopy", () => {
  it("never invents demo people in the browser", () => {
    const copy = emptyCopy({
      isTauri: false,
      credentialsConfigured: false,
      hostedOAuthReady: false,
      oauthInProgress: false,
      hasChannels: false,
    });
    expect(copy.kind).toBe("browser");
    expect(copy.showConnect).toBe(false);
    expect(copy.title).not.toMatch(/demo/i);
  });

  it("does not show a dead Connect button when credentials are missing", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: false,
      hostedOAuthReady: false,
      oauthInProgress: false,
      hasChannels: false,
    });
    expect(copy.kind).toBe("missing-credentials");
    expect(copy.showConnect).toBe(true);
    expect(copy.connectLabel).toBe("Open settings");
    expect(copy.copy).not.toMatch(/\.env/);
    expect(copy.copy).toMatch(/not set up/i);
    expect(copy.copy).toMatch(/Open Settings/);
    expect(copy.copy).not.toMatch(/Client ID/);
  });

  it("shows a connect CTA once credentials exist", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
      hostedOAuthReady: true,
      oauthInProgress: false,
      hasChannels: false,
    });
    expect(copy.kind).toBe("ready-to-connect");
    expect(copy.showConnect).toBe(true);
    expect(copy.connectLabel).toBe("Connect Slack");
  });

  it("shows waiting copy and cancel while Slack OAuth is in the browser", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
      hostedOAuthReady: true,
      oauthInProgress: true,
      hasChannels: false,
    });
    expect(copy.kind).toBe("oauth-pending");
    expect(copy.showConnect).toBe(false);
    expect(copy.showCancel).toBe(true);
    expect(copy.copy).toMatch(/on its own/);
  });

  it("shows reconnect copy after a token is revoked or missing", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
      hostedOAuthReady: true,
      oauthInProgress: false,
      workspace: staleWorkspace,
      hasChannels: false,
    });
    expect(copy.kind).toBe("reconnect");
    expect(copy.showConnect).toBe(true);
    expect(copy.connectLabel).toBe("Reconnect Slack");
    expect(copy.copy).toMatch(/expired|revoked|missing/);
  });

  it("explains a workspace with no channels the user can see", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
      hostedOAuthReady: true,
      oauthInProgress: false,
      workspace: liveWorkspace,
      hasChannels: false,
    });
    expect(copy.kind).toBe("no-channels");
    expect(copy.showConnect).toBe(false);
  });

  it("explains an empty channel without falling back to sample members", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
      hostedOAuthReady: true,
      oauthInProgress: false,
      workspace: liveWorkspace,
      hasChannels: true,
    });
    expect(copy.kind).toBe("empty-channel");
    expect(copy.showConnect).toBe(false);
  });
});

describe("workspaceLabel", () => {
  it("uses the real team name, or Not connected when none is linked", () => {
    expect(workspaceLabel(liveWorkspace)).toBe("Acme Studio");
    expect(workspaceLabel(undefined)).toBe("Not connected");
  });
});
