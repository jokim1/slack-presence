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
    : "Connect with your own Slack app";

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
        : "These saved credentials are used when you add another workspace.",
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
        : "Fill the boxes below, then click Reconnect Slack. They save immediately.",
    };
  }

  if (!status.credentialsConfigured) {
    return {
      modeLabel: "Not connected",
      connectionNote:
        "One-click Slack login is not set up on this build yet. To connect now, use your own Slack app in the boxes below, then click Connect Slack.",
      connectLabel: "Connect Slack",
      connectHidden: false,
      connectDisabled: false,
      cancelHidden: true,
      logoutHidden: true,
      logoutLabel: "Disconnect workspace",
      advancedOpen: true,
      advancedSummary,
      credentialsNote:
        "In a browser open api.slack.com/apps and create an app named Presence for Slack. Under Basic Information, copy Client ID and Client Secret into the boxes below. Click Connect Slack — it saves immediately, no restart. Full steps: SETUP.md, Advanced / self-hosting.",
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
          : "One-click Slack login is not set up on this build yet. Open Settings if you want to connect with your own Slack app in the meantime.",
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
