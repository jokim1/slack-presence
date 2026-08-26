import type { AppStatus, WorkspaceStatus } from "./types";

export interface SettingsCopy {
  modeLabel: string;
  connectionNote: string;
  connectLabel: string;
  connectDisabled: boolean;
  logoutHidden: boolean;
  logoutLabel: string;
}

export type EmptyKind =
  | "browser"
  | "missing-credentials"
  | "ready-to-connect"
  | "reconnect"
  | "no-channels"
  | "empty-channel";

export interface EmptyCopy {
  kind: EmptyKind;
  title: string;
  copy: string;
  showConnect: boolean;
  connectLabel: string;
}

export function settingsCopy(
  status: AppStatus,
  workspace: WorkspaceStatus | undefined,
  isTauri: boolean,
): SettingsCopy {
  if (workspace) {
    return {
      modeLabel: workspace.teamName,
      connectionNote: workspace.connected
        ? "Connected with a user token stored in macOS Keychain."
        : "This workspace needs to be reconnected.",
      connectLabel: "Reconnect Slack",
      connectDisabled: !isTauri || !status.credentialsConfigured,
      logoutHidden: false,
      logoutLabel: `Disconnect ${workspace.teamName}`,
    };
  }

  if (!isTauri) {
    return {
      modeLabel: "Not connected",
      connectionNote: "OAuth and Keychain access are available in the macOS desktop app.",
      connectLabel: "Connect Slack",
      connectDisabled: true,
      logoutHidden: true,
      logoutLabel: "Disconnect workspace",
    };
  }

  if (!status.credentialsConfigured) {
    return {
      modeLabel: "Not connected",
      connectionNote: "Add your Client ID and Secret to .env, then restart the app. See SETUP.md.",
      connectLabel: "Connect Slack",
      connectDisabled: true,
      logoutHidden: true,
      logoutLabel: "Disconnect workspace",
    };
  }

  return {
    modeLabel: "Not connected",
    connectionNote:
      "Your local app credentials are ready. Connect a Slack workspace to load live people and presence.",
    connectLabel: "Connect Slack",
    connectDisabled: false,
    logoutHidden: true,
    logoutLabel: "Disconnect workspace",
  };
}

export function emptyCopy(input: {
  isTauri: boolean;
  credentialsConfigured: boolean;
  workspace?: WorkspaceStatus;
  hasChannels: boolean;
}): EmptyCopy {
  const { isTauri, credentialsConfigured, workspace, hasChannels } = input;

  if (!isTauri) {
    return {
      kind: "browser",
      title: "Open the macOS app",
      copy: "OAuth, Keychain, and Slack presence live in the desktop app. Run npm run tauri dev after following SETUP.md.",
      showConnect: false,
      connectLabel: "Connect Slack",
    };
  }

  if (!workspace) {
    if (!credentialsConfigured) {
      return {
        kind: "missing-credentials",
        title: "Connect Slack",
        copy: "Add your Client ID and Secret to .env, then restart the app. See SETUP.md.",
        showConnect: false,
        connectLabel: "Connect Slack",
      };
    }
    return {
      kind: "ready-to-connect",
      title: "Connect a workspace",
      copy: "Authorize Slack to load the people in a channel you belong to. Presence is Slack's active or away signal.",
      showConnect: true,
      connectLabel: "Connect Slack",
    };
  }

  if (!workspace.connected) {
    return {
      kind: "reconnect",
      title: "Reconnect this workspace",
      copy: "The Slack token is missing, expired, or revoked. Reconnect to load live people and presence.",
      showConnect: credentialsConfigured,
      connectLabel: "Reconnect Slack",
    };
  }

  if (!hasChannels) {
    return {
      kind: "no-channels",
      title: "No channels found",
      copy: "This workspace did not return any public or private channels you belong to.",
      showConnect: false,
      connectLabel: "Connect Slack",
    };
  }

  return {
    kind: "empty-channel",
    title: "No people to show",
    copy: "This channel may be empty or its members are bots and deactivated accounts.",
    showConnect: false,
    connectLabel: "Connect Slack",
  };
}

export function workspaceLabel(workspace: WorkspaceStatus | undefined): string {
  return workspace?.teamName ?? "Not connected";
}
