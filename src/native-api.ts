import { invoke } from "@tauri-apps/api/core";
import type {
  AppStatus,
  Channel,
  Member,
  OAuthComplete,
  PanelVisibility,
  PresenceReply,
} from "./types";

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Slack asked us to wait ${retryAfterSeconds} seconds`);
    this.name = "RateLimitError";
  }
}

export class ReauthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthError";
  }
}

const BROWSER_STATUS: AppStatus = {
  credentialsConfigured: false,
  hostedOAuthReady: false,
  clientId: "",
  hasClientSecret: false,
  exchangeUrl: "",
  oauthInProgress: false,
  workspaces: [],
  activeTeamId: null,
  alwaysOnTop: false,
  redirectUri: "http://127.0.0.1:53641/oauth/callback",
};

export function commandError(error: unknown): Error {
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return commandError(JSON.parse(trimmed) as unknown);
      } catch {
        return new Error(error);
      }
    }
    return new Error(error);
  }
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    if (value.kind === "rateLimited") {
      return new RateLimitError(Number(value.retryAfterSeconds) || 60);
    }
    if (value.kind === "reauth") {
      return new ReauthError(String(value.message ?? "Reconnect Slack"));
    }
    if (typeof value.message === "string") return new Error(value.message);
  }
  return new Error("Native command failed");
}

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw commandError(error);
  }
}

export async function getAppStatus(): Promise<AppStatus> {
  if (!isTauri) return { ...BROWSER_STATUS };
  return native<AppStatus>("get_app_status");
}

export async function listChannels(teamId: string): Promise<Channel[]> {
  return native<Channel[]>("list_channels", { teamId });
}

export async function loadMembers(teamId: string, channelId: string): Promise<Member[]> {
  return native<Member[]>("get_channel_members", { teamId, channelId });
}

export async function getPresence(teamId: string, userId: string): Promise<PresenceReply> {
  return native<PresenceReply>("get_presence", { teamId, userId });
}

export async function setActiveWorkspace(teamId: string): Promise<void> {
  if (isTauri) await native("set_active_workspace", { teamId });
}

export async function saveSelectedChannel(teamId: string, channelId: string): Promise<void> {
  if (isTauri) await native("save_selected_channel", { teamId, channelId });
}

export async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  if (isTauri) await native("set_always_on_top", { enabled });
}

export async function startOAuth(): Promise<void> {
  if (!isTauri) {
    throw new Error("Connect Slack from the macOS desktop app.");
  }
  await native("start_oauth");
}

export async function cancelOAuth(): Promise<void> {
  if (!isTauri) return;
  await native("cancel_oauth");
}

export async function saveSlackCredentials(input: {
  clientId: string;
  clientSecret?: string;
  exchangeUrl?: string;
  clearSecret?: boolean;
}): Promise<void> {
  if (!isTauri) {
    throw new Error("Credentials can only be saved in the macOS desktop app.");
  }
  await native("save_slack_credentials", {
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    exchangeUrl: input.exchangeUrl,
    clearSecret: input.clearSecret ?? false,
  });
}

export async function disconnectWorkspace(teamId: string): Promise<void> {
  await native("disconnect_workspace", { teamId });
}

export async function openDm(teamId: string, userId: string): Promise<void> {
  if (isTauri) await native("open_dm", { teamId, userId });
}

export async function hidePanel(): Promise<void> {
  if (isTauri) await native("hide_panel");
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauri) return;
  await invoke("plugin:window|start_dragging", { label: "main" });
}

export async function listenForOAuth(
  handler: (event: OAuthComplete) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<OAuthComplete>("oauth://complete", ({ payload }) => handler(payload));
}

export async function listenForAuthorizeUrl(
  handler: (url: string) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("oauth://authorize-url", ({ payload }) => handler(payload));
}

export async function listenForPanelVisibility(
  handler: (event: PanelVisibility) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PanelVisibility>("panel://visibility", ({ payload }) =>
    handler(payload),
  );
}

export async function listenForTrayConnect(handler: () => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen("tray://connect", () => handler());
}

export async function listenForTraySettings(handler: () => void): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen("tray://settings", () => handler());
}
