export type Presence = "active" | "away";

export interface AppStatus {
  credentialsConfigured: boolean;
  authenticated: boolean;
  teamId: string | null;
  teamName: string | null;
  selectedChannelId: string | null;
  alwaysOnTop: boolean;
  redirectUri: string;
}

export interface Channel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface Member {
  id: string;
  displayName: string;
  title: string;
  avatarUrl: string;
  presence: Presence;
}

export interface PresenceReply {
  userId: string;
  presence: Presence;
}

export interface OAuthComplete {
  ok: boolean;
  message: string;
}

export interface PanelVisibility {
  visible: boolean;
}
