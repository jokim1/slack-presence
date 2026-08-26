import { describe, expect, it } from "vitest";
import { emptyCopy, settingsCopy, workspaceLabel } from "./connection-state";
import type { AppStatus, WorkspaceStatus } from "./types";

const unconfigured: AppStatus = {
  credentialsConfigured: false,
  workspaces: [],
  activeTeamId: null,
  alwaysOnTop: false,
  redirectUri: "http://127.0.0.1:53641/oauth/callback",
};

const ready: AppStatus = { ...unconfigured, credentialsConfigured: true };

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
  it("tells the browser preview to use the macOS app", () => {
    const copy = settingsCopy(ready, undefined, false);
    expect(copy.connectDisabled).toBe(true);
    expect(copy.logoutHidden).toBe(true);
    expect(copy.modeLabel).toBe("Not connected");
    expect(copy.connectionNote).toMatch(/macOS desktop app/);
  });

  it("blocks connect until .env credentials exist", () => {
    const copy = settingsCopy(unconfigured, undefined, true);
    expect(copy.connectDisabled).toBe(true);
    expect(copy.connectionNote).toMatch(/SETUP\.md/);
    expect(copy.logoutHidden).toBe(true);
  });

  it("enables connect when credentials are ready and no workspace is linked", () => {
    const copy = settingsCopy(ready, undefined, true);
    expect(copy.connectDisabled).toBe(false);
    expect(copy.connectLabel).toBe("Connect Slack");
    expect(copy.connectionNote).toMatch(/Connect a Slack workspace/);
    expect(copy.connectionNote).not.toMatch(/demo/i);
  });

  it("offers reconnect and disconnect for a live workspace", () => {
    const copy = settingsCopy(ready, liveWorkspace, true);
    expect(copy.modeLabel).toBe("Acme Studio");
    expect(copy.connectLabel).toBe("Reconnect Slack");
    expect(copy.logoutHidden).toBe(false);
    expect(copy.logoutLabel).toBe("Disconnect Acme Studio");
    expect(copy.connectionNote).toMatch(/Keychain/);
  });

  it("asks to reconnect a workspace whose token is gone", () => {
    const copy = settingsCopy(ready, staleWorkspace, true);
    expect(copy.connectionNote).toMatch(/reconnected/);
    expect(copy.connectDisabled).toBe(false);
  });
});

describe("emptyCopy", () => {
  it("never invents demo people in the browser", () => {
    const copy = emptyCopy({
      isTauri: false,
      credentialsConfigured: false,
      hasChannels: false,
    });
    expect(copy.kind).toBe("browser");
    expect(copy.showConnect).toBe(false);
    expect(copy.title).not.toMatch(/demo/i);
  });

  it("shows credential setup when the desktop app has no .env", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: false,
      hasChannels: false,
    });
    expect(copy.kind).toBe("missing-credentials");
    expect(copy.copy).toMatch(/SETUP\.md/);
    expect(copy.showConnect).toBe(false);
  });

  it("shows a connect CTA once credentials exist", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
      hasChannels: false,
    });
    expect(copy.kind).toBe("ready-to-connect");
    expect(copy.showConnect).toBe(true);
    expect(copy.connectLabel).toBe("Connect Slack");
  });

  it("shows reconnect copy after a token is revoked or missing", () => {
    const copy = emptyCopy({
      isTauri: true,
      credentialsConfigured: true,
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
