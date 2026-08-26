import type { AppStatus, WorkspaceStatus } from "./types";

export interface SettingsCopy {
  modeLabel: string;
  connectionNote: string;
  connectLabel: string;
  connectHidden: boolean;
  connectDisabled: boolean;
  cancelHidden: boolean;
  logoutHidden: boolean;
  logoutLabel: string;
  advancedOpen: boolean;
  advancedSummary: string;
  credentialsNote: string;
}

export type EmptyKind =
  | "browser"
  | "missing-credentials"
  | "ready-to-connect"
  | "oauth-pending"
  | "reconnect"
  | "no-channels"
  | "empty-channel";

export interface EmptyCopy {
  kind: EmptyKind;
  title: string;
  copy: string;
  showConnect: boolean;
  connectLabel: string;
  showCancel: boolean;
}

export function settingsCopy(
  status: AppStatus,
  workspace: WorkspaceStatus | undefined,
  isTauri: boolean,
): SettingsCopy {
  const advancedOpen = isTauri && !status.hostedOAuthReady;
  const advancedSummary = status.hostedOAuthReady
    ? "Use your own Slack app"
    : "Slack app credentials";

  if (!isTauri) {
    return {
      modeLabel: workspace?.teamName ?? "Not connected",
      connectionNote: "OAuth and Keychain access are available in the macOS desktop app.",
      connectLabel: "Connect Slack",
      connectHidden: true,
      connectDisabled: true,
      cancelHidden: true,
      logoutHidden: true,
      logoutLabel: "Disconnect workspace",
      advancedOpen: false,
      advancedSummary,
      credentialsNote: "Connect from the macOS app. Credentials are not saved in the browser preview.",
    };
  }

  if (status.oauthInProgress) {
    return {
      modeLabel: workspace?.teamName ?? "Connecting…",
      connectionNote: "Finish signing in with Slack in your browser. This window will connect on its own.",
      connectLabel: "Connect Slack",
      connectHidden: true,
      connectDisabled: true,
      cancelHidden: false,
      logoutHidden: true,
      logoutLabel: "Disconnect workspace",
      advancedOpen: false,
      advancedSummary,
      credentialsNote: "",
    };
  }

  if (workspace?.connected) {
    return {
      modeLabel: workspace.teamName,
      connectionNote: "Connected with a user token stored in macOS Keychain.",
      connectLabel: "Connect Slack",
      connectHidden: true,
      connectDisabled: true,
      cancelHidden: true,
      logoutHidden: false,
      logoutLabel: `Disconnect ${workspace.teamName}`,
      advancedOpen: false,
      advancedSummary,
      credentialsNote: status.hostedOAuthReady
        ? "One-click connect is configured. Use your own Slack app only if you are self-hosting."
        : "Add a workspace uses these credentials. One-click connect is unavailable until the shared Slack app is configured.",
    };
  }

  if (workspace && !workspace.connected) {
    return {
      modeLabel: workspace.teamName,
      connectionNote: "This workspace needs to be reconnected.",
      connectLabel: "Reconnect Slack",
      connectHidden: !status.credentialsConfigured,
      connectDisabled: !status.credentialsConfigured,
      cancelHidden: true,
      logoutHidden: false,
      logoutLabel: `Disconnect ${workspace.teamName}`,
      advancedOpen,
      advancedSummary,
      credentialsNote: status.credentialsConfigured
        ? ""
        : "Paste your Slack Client ID and Secret, then reconnect. Applied immediately, no restart.",
    };
  }

  if (!status.credentialsConfigured) {
    return {
      modeLabel: "Not connected",
      connectionNote:
        "This build does not include a shared Slack app yet. Paste your Client ID and Secret below to connect. Applied immediately, no restart.",
      connectLabel: "Connect Slack",
      connectHidden: true,
      connectDisabled: true,
      cancelHidden: true,
      logoutHidden: true,
      logoutLabel: "Disconnect workspace",
      advancedOpen: true,
      advancedSummary,
      credentialsNote: "Create a Slack app under Advanced / self-hosting in SETUP.md, or wait for one-click once the shared app is configured.",
    };
  }

  return {
    modeLabel: "Not connected",
    connectionNote: status.hostedOAuthReady
      ? "Connect a Slack workspace to load live people and presence. Slack handles login and 2FA in the browser."
      : "Your Slack app credentials are saved. Connect a workspace to load live people and presence.",
    connectLabel: "Connect Slack",
    connectHidden: false,
    connectDisabled: false,
    cancelHidden: true,
    logoutHidden: true,
    logoutLabel: "Disconnect workspace",
    advancedOpen,
    advancedSummary,
    credentialsNote: status.hostedOAuthReady
      ? "Optional. Overrides the shared Slack app for this Mac only."
      : "",
  };
}

export function emptyCopy(input: {
  isTauri: boolean;
  credentialsConfigured: boolean;
  hostedOAuthReady: boolean;
  oauthInProgress: boolean;
  workspace?: WorkspaceStatus;
  hasChannels: boolean;
}): EmptyCopy {
  const {
    isTauri,
    credentialsConfigured,
    hostedOAuthReady,
    oauthInProgress,
    workspace,
    hasChannels,
  } = input;

  if (!isTauri) {
    return {
      kind: "browser",
      title: "Open the macOS app",
      copy: "OAuth, Keychain, and Slack presence live in the desktop app. Run npm run tauri dev.",
      showConnect: false,
      connectLabel: "Connect Slack",
      showCancel: false,
    };
  }

  if (oauthInProgress) {
    return {
      kind: "oauth-pending",
      title: "Waiting for Slack",
      copy: "Finish signing in with Slack in your browser. This window will connect on its own.",
      showConnect: false,
      connectLabel: "Connect Slack",
      showCancel: true,
    };
  }

  if (!workspace) {
    if (!credentialsConfigured) {
      return {
        kind: "missing-credentials",
        title: "Connect Slack",
        copy: hostedOAuthReady
          ? "Open Settings and try Connect Slack again."
          : "Paste a Slack Client ID and Secret in Settings to connect. One-click connect is unavailable until the shared Slack app is configured.",
        showConnect: true,
        connectLabel: "Open settings",
        showCancel: false,
      };
    }
    return {
      kind: "ready-to-connect",
      title: "Connect a workspace",
      copy: "Authorize Slack to load the people in a channel you belong to. Presence is Slack's active or away signal.",
      showConnect: true,
      connectLabel: "Connect Slack",
      showCancel: false,
    };
  }

  if (!workspace.connected) {
    return {
      kind: "reconnect",
      title: "Reconnect this workspace",
      copy: "The Slack token is missing, expired, or revoked. Reconnect to load live people and presence.",
      showConnect: credentialsConfigured,
      connectLabel: "Reconnect Slack",
      showCancel: false,
    };
  }

  if (!hasChannels) {
    return {
      kind: "no-channels",
      title: "No channels found",
      copy: "This workspace did not return any public or private channels you belong to.",
      showConnect: false,
      connectLabel: "Connect Slack",
      showCancel: false,
    };
  }

  return {
    kind: "empty-channel",
    title: "No people to show",
    copy: "This channel may be empty or its members are bots and deactivated accounts.",
    showConnect: false,
    connectLabel: "Connect Slack",
    showCancel: false,
  };
}

export function workspaceLabel(workspace: WorkspaceStatus | undefined): string {
  return workspace?.teamName ?? "Not connected";
}
