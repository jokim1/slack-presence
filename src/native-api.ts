import { invoke } from "@tauri-apps/api/core";
import {
  MOCK_TEAM_ID,
  MOCK_TEAM_NAME,
  mockChannels,
  mockMembersByChannel,
  mockPresence,
} from "./mock-data";
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

function commandError(error: unknown): Error {
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
  return new Error(typeof error === "string" ? error : "Native command failed");
}

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw commandError(error);
  }
}

export async function getAppStatus(): Promise<AppStatus> {
  if (!isTauri) {
    return {
      credentialsConfigured: false,
      authenticated: false,
      teamId: MOCK_TEAM_ID,
      teamName: MOCK_TEAM_NAME,
      selectedChannelId: mockChannels[0]?.id ?? null,
      alwaysOnTop: false,
      redirectUri: "http://127.0.0.1:53641/oauth/callback",
    };
  }
  return native<AppStatus>("get_app_status");
}

export async function listChannels(useMock: boolean): Promise<Channel[]> {
  if (useMock) return structuredClone(mockChannels);
  return native<Channel[]>("list_channels");
}

export async function loadMembers(
  channelId: string,
  useMock: boolean,
): Promise<Member[]> {
  if (useMock) return structuredClone(mockMembersByChannel[channelId] ?? []);
  return native<Member[]>("get_channel_members", { channelId });
}

export async function getPresence(
  userId: string,
  useMock: boolean,
): Promise<PresenceReply> {
  if (useMock) return mockPresence(userId);
  return native<PresenceReply>("get_presence", { userId });
}

export async function saveSelectedChannel(channelId: string): Promise<void> {
  if (isTauri) await native("save_selected_channel", { channelId });
}

export async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  if (isTauri) await native("set_always_on_top", { enabled });
}

export async function startOAuth(): Promise<void> {
  await native("start_oauth");
}

export async function logout(): Promise<void> {
  await native("logout");
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

export async function listenForPanelVisibility(
  handler: (event: PanelVisibility) => void,
): Promise<() => void> {
  if (!isTauri) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PanelVisibility>("panel://visibility", ({ payload }) =>
    handler(payload),
  );
}
