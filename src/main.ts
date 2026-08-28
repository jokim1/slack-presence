import "./styles.css";
import { emptyCopy, settingsCopy, workspaceLabel } from "./connection-state";
import {
  cancelOAuth,
  disconnectWorkspace,
  getAppStatus,
  getPresence,
  hidePanel,
  isTauri,
  listChannels,
  listenForAuthorizeUrl,
  listenForOAuth,
  listenForPanelVisibility,
  listenForTrayConnect,
  listenForTraySettings,
  loadMembers,
  openDm,
  ReauthError,
  saveSelectedChannel,
  saveSlackCredentials,
  setActiveWorkspace,
  setAlwaysOnTop,
  startOAuth,
  startWindowDrag,
} from "./native-api";
import { cadenceForMemberCount, PresenceScheduler } from "./presence-scheduler";
import type { AppStatus, Channel, Member, PresenceReply, WorkspaceStatus } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root is missing");

app.innerHTML = `
  <div class="app-shell">
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand-mark" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
          <defs>
            <linearGradient id="brand-bg" x1="96" y1="36" x2="430" y2="490" gradientUnits="userSpaceOnUse">
              <stop stop-color="#6D65F2"/>
              <stop offset="1" stop-color="#3A3394"/>
            </linearGradient>
            <linearGradient id="brand-sheen" x1="256" y1="28" x2="256" y2="250" gradientUnits="userSpaceOnUse">
              <stop stop-color="#fff" stop-opacity=".22"/>
              <stop offset="1" stop-color="#fff" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <rect x="28" y="28" width="456" height="456" rx="128" fill="url(#brand-bg)"/>
          <rect x="28" y="28" width="456" height="456" rx="128" fill="url(#brand-sheen)"/>
          <rect x="30.5" y="30.5" width="451" height="451" rx="126" stroke="#fff" stroke-opacity=".16" stroke-width="3"/>
          <circle cx="206" cy="168" r="72" fill="#F5F4FF"/>
          <path d="M112 332c0-50 42-88 94-88s94 38 94 88v44c0 36-42 62-94 62s-94-26-94-62z" fill="#F5F4FF"/>
          <circle cx="354" cy="352" r="94" fill="#4B44C4"/>
          <circle cx="354" cy="352" r="84" fill="#30D158"/>
          <path d="M322 354l24 26 46-48" stroke="#fff" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <button class="workspace-switcher" id="workspace-toggle" aria-haspopup="listbox" aria-expanded="false">
        <span class="brand-copy">
          <strong>Presence</strong>
          <span id="workspace-name">Starting up…</span>
        </span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
      </button>
      <div class="window-actions">
        <button class="icon-button" id="settings-toggle" aria-label="Open settings" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm8 3.5-1.7-.7a7 7 0 0 0-.5-1.3l.7-1.7-2.8-2.8-1.7.7a7 7 0 0 0-1.3-.5L12 4H8l-.7 1.7a7 7 0 0 0-1.3.5l-1.7-.7-2.8 2.8.7 1.7a7 7 0 0 0-.5 1.3L0 12v4l1.7.7a7 7 0 0 0 .5 1.3l-.7 1.7 2.8 2.8 1.7-.7a7 7 0 0 0 1.3.5L8 24h4l.7-1.7a7 7 0 0 0 1.3-.5l1.7.7 2.8-2.8-.7-1.7a7 7 0 0 0 .5-1.3L20 16v-4Z" transform="translate(2 -2) scale(.83)"/></svg>
        </button>
        <button class="icon-button hide-button" id="hide-panel" aria-label="Hide panel">−</button>
      </div>
    </header>

    <div class="status-banner" id="status-banner" hidden></div>

    <section class="channel-bar">
      <button class="channel-button" id="channel-toggle" aria-haspopup="listbox" aria-expanded="false">
        <span id="channel-name">Choose a channel</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
      </button>
      <button class="icon-button refresh-button" id="refresh" aria-label="Refresh members">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M18.5 9A7 7 0 0 0 6.3 6.3L4 9m16 6-2.3 2.7A7 7 0 0 1 5.5 15"/></svg>
      </button>
    </section>

    <section class="popover workspace-popover" id="workspace-popover" hidden>
      <div class="workspace-options" id="workspace-options" role="listbox"></div>
      <div class="settings-divider"></div>
      <button class="workspace-add" id="add-workspace">
        <span aria-hidden="true">+</span> Add a workspace
      </button>
    </section>

    <section class="popover channel-popover" id="channel-popover" hidden>
      <label class="search-field">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg>
        <input id="channel-search" type="search" placeholder="Find a channel" autocomplete="off" />
      </label>
      <div class="channel-options" id="channel-options" role="listbox"></div>
    </section>

    <section class="popover settings-popover" id="settings-popover" hidden>
      <div class="settings-heading">
        <strong>Settings</strong>
        <span id="mode-label">Not connected</span>
      </div>
      <label class="toggle-row">
        <span><strong>Keep panel on top</strong><small>Stay visible above other windows</small></span>
        <input id="always-on-top" type="checkbox" role="switch" />
      </label>
      <div class="settings-divider"></div>
      <p class="settings-note" id="connection-note"></p>
      <button class="primary-button" id="connect-button">Connect Slack</button>
      <button class="text-button" id="cancel-oauth" hidden>Cancel</button>
      <div class="oauth-link" id="settings-oauth-link-wrap" hidden>
        <p>or copy this link into your browser</p>
        <div class="oauth-link-row">
          <input id="settings-oauth-link" type="text" readonly />
          <button class="primary-button" id="copy-settings-oauth-link" type="button">Copy</button>
        </div>
      </div>
      <details class="advanced-credentials" id="advanced-credentials">
        <summary id="advanced-summary">Use your own Slack app</summary>
        <p class="settings-note" id="credentials-note"></p>
        <label class="field">
          <span>Client ID</span>
          <input id="client-id" type="text" autocomplete="off" spellcheck="false" />
        </label>
        <label class="field">
          <span>Client Secret</span>
          <input id="client-secret" type="password" autocomplete="off" />
        </label>
        <label class="field">
          <span>Exchange URL</span>
          <input id="exchange-url" type="url" autocomplete="off" spellcheck="false" />
        </label>
        <button class="text-button" id="save-credentials" type="button">Save credentials</button>
      </details>
      <button class="text-button danger" id="logout-button" hidden>Disconnect workspace</button>
    </section>

    <main class="people-panel" aria-live="polite">
      <div class="people-heading">
        <span>People</span>
        <span id="people-count">0 members</span>
      </div>
      <div class="member-list" id="member-list"></div>
      <div class="empty-state" id="empty-state" hidden>
        <div class="empty-orbit" aria-hidden="true"><span></span></div>
        <strong id="empty-title">Connect Slack</strong>
        <p id="empty-copy">Connect a workspace to see who's around in a channel you belong to.</p>
        <button class="primary-button" id="empty-connect" hidden>Connect Slack</button>
        <button class="text-button" id="empty-cancel" hidden>Cancel</button>
        <div class="oauth-link" id="oauth-link-wrap" hidden>
          <p>or copy this link into your browser</p>
          <div class="oauth-link-row">
            <input id="oauth-link" type="text" readonly />
            <button class="primary-button" id="copy-oauth-link" type="button">Copy</button>
          </div>
        </div>
      </div>
    </main>

    <footer class="footer">
      <span class="active-summary"><i></i><span id="active-count">0 active</span></span>
      <span id="freshness">Not connected</span>
    </footer>
    <div class="toast" id="toast" role="status" hidden></div>
  </div>
`;

function element<T extends HTMLElement>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`Missing UI element: ${selector}`);
  return value;
}

const ui = {
  workspace: element<HTMLElement>("#workspace-name"),
  workspaceToggle: element<HTMLButtonElement>("#workspace-toggle"),
  workspacePopover: element<HTMLElement>("#workspace-popover"),
  workspaceOptions: element<HTMLElement>("#workspace-options"),
  addWorkspace: element<HTMLButtonElement>("#add-workspace"),
  channelName: element<HTMLElement>("#channel-name"),
  channelToggle: element<HTMLButtonElement>("#channel-toggle"),
  channelPopover: element<HTMLElement>("#channel-popover"),
  channelSearch: element<HTMLInputElement>("#channel-search"),
  channelOptions: element<HTMLElement>("#channel-options"),
  settingsToggle: element<HTMLButtonElement>("#settings-toggle"),
  settingsPopover: element<HTMLElement>("#settings-popover"),
  modeLabel: element<HTMLElement>("#mode-label"),
  connectionNote: element<HTMLElement>("#connection-note"),
  alwaysOnTop: element<HTMLInputElement>("#always-on-top"),
  connect: element<HTMLButtonElement>("#connect-button"),
  cancelOAuth: element<HTMLButtonElement>("#cancel-oauth"),
  advanced: element<HTMLDetailsElement>("#advanced-credentials"),
  advancedSummary: element<HTMLElement>("#advanced-summary"),
  credentialsNote: element<HTMLElement>("#credentials-note"),
  clientId: element<HTMLInputElement>("#client-id"),
  clientSecret: element<HTMLInputElement>("#client-secret"),
  exchangeUrl: element<HTMLInputElement>("#exchange-url"),
  saveCredentials: element<HTMLButtonElement>("#save-credentials"),
  logout: element<HTMLButtonElement>("#logout-button"),
  refresh: element<HTMLButtonElement>("#refresh"),
  hidePanel: element<HTMLButtonElement>("#hide-panel"),
  banner: element<HTMLElement>("#status-banner"),
  memberList: element<HTMLElement>("#member-list"),
  emptyState: element<HTMLElement>("#empty-state"),
  emptyTitle: element<HTMLElement>("#empty-title"),
  emptyCopy: element<HTMLElement>("#empty-copy"),
  emptyConnect: element<HTMLButtonElement>("#empty-connect"),
  emptyCancel: element<HTMLButtonElement>("#empty-cancel"),
  oauthLinkWrap: element<HTMLElement>("#oauth-link-wrap"),
  oauthLink: element<HTMLInputElement>("#oauth-link"),
  copyOauthLink: element<HTMLButtonElement>("#copy-oauth-link"),
  settingsOauthLinkWrap: element<HTMLElement>("#settings-oauth-link-wrap"),
  settingsOauthLink: element<HTMLInputElement>("#settings-oauth-link"),
  copySettingsOauthLink: element<HTMLButtonElement>("#copy-settings-oauth-link"),
  peopleCount: element<HTMLElement>("#people-count"),
  activeCount: element<HTMLElement>("#active-count"),
  freshness: element<HTMLElement>("#freshness"),
  toast: element<HTMLElement>("#toast"),
};

const EMPTY_STATUS: AppStatus = {
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

let status: AppStatus = { ...EMPTY_STATUS };
let workspaces: WorkspaceStatus[] = [];
let activeTeamId = "";
let channels: Channel[] = [];
let members: Member[] = [];
let selectedChannelId = "";
let panelVisible = true;
let toastTimer: number | undefined;
let oauthInFlight = false;
let oauthAuthorizeUrl = "";

const scheduler = new PresenceScheduler({
  request: (userId) => getPresence(activeTeamId, userId),
  onChange: patchPresence,
  onRateLimit: (seconds) => {
    showBanner(`Slack is rate limiting presence checks. Retrying in ${seconds}s.`, "warning");
    ui.freshness.textContent = "Presence paused";
  },
  onError: (error) => {
    if (error instanceof ReauthError) {
      markWorkspaceDisconnected(error.message);
      return;
    }
    showBanner(error.message, "error");
    ui.freshness.textContent = "Last-known presence";
  },
});

function activeWorkspace(): WorkspaceStatus | undefined {
  return workspaces.find(({ teamId }) => teamId === activeTeamId);
}

function workspaceIsLive(): boolean {
  return Boolean(activeWorkspace()?.connected);
}

function applyStatus(): void {
  workspaces = status.workspaces;
  const stillListed = workspaces.some(({ teamId }) => teamId === activeTeamId);
  activeTeamId = status.activeTeamId ?? (stillListed ? activeTeamId : workspaces[0]?.teamId ?? "");
}

function showBanner(message: string, tone: "info" | "warning" | "error" = "info"): void {
  ui.banner.textContent = message;
  ui.banner.dataset.tone = tone;
  ui.banner.hidden = false;
}

function hideBanner(): void {
  ui.banner.hidden = true;
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, 2_800);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function sortedMembers(): Member[] {
  return [...members].sort((a, b) => {
    if (a.presence !== b.presence) return a.presence === "active" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

function createMemberRow(member: Member): HTMLButtonElement {
  const row = document.createElement("button");
  row.className = "member-row";
  row.type = "button";
  row.dataset.memberId = member.id;
  row.setAttribute(
    "aria-label",
    `${member.displayName}, ${member.title || "no title"}, ${member.presence}. Open direct message`,
  );

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.dataset.color = String(
    [...member.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5,
  );
  if (member.avatarUrl) {
    const image = document.createElement("img");
    image.src = member.avatarUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    avatar.append(image);
  } else {
    avatar.textContent = initials(member.displayName);
  }

  const dot = document.createElement("i");
  dot.className = `presence-dot ${member.presence}`;
  dot.setAttribute("aria-hidden", "true");
  avatar.append(dot);

  const copy = document.createElement("span");
  copy.className = "member-copy";
  const name = document.createElement("strong");
  name.textContent = member.displayName;
  const title = document.createElement("span");
  title.textContent = member.title || "Slack member";
  copy.append(name, title);

  const arrow = document.createElement("span");
  arrow.className = "row-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↗";

  row.append(avatar, copy, arrow);
  row.addEventListener("click", () => void handleMemberClick(member));
  return row;
}

function applyEmptyState(): void {
  const copy = emptyCopy({
    isTauri,
    credentialsConfigured: status.credentialsConfigured,
    hostedOAuthReady: status.hostedOAuthReady,
    oauthInProgress: oauthInFlight || status.oauthInProgress,
    workspace: activeWorkspace(),
    hasChannels: channels.length > 0,
  });
  ui.emptyTitle.textContent = copy.title;
  ui.emptyCopy.textContent = copy.copy;
  ui.emptyConnect.hidden = !copy.showConnect;
  ui.emptyConnect.textContent = copy.connectLabel;
  ui.emptyConnect.disabled = false;
  ui.emptyCancel.hidden = !copy.showCancel;
  updateOAuthLinkControls(copy.showCancel);
  ui.emptyState.hidden = members.length > 0;
}

function updateOAuthLinkControls(show: boolean): void {
  ui.oauthLink.value = oauthAuthorizeUrl;
  ui.settingsOauthLink.value = oauthAuthorizeUrl;
  ui.oauthLinkWrap.hidden = !show || !oauthAuthorizeUrl;
  ui.settingsOauthLinkWrap.hidden = !show || !oauthAuthorizeUrl;
  ui.copyOauthLink.disabled = !oauthAuthorizeUrl;
  ui.copySettingsOauthLink.disabled = !oauthAuthorizeUrl;
}

function renderMembers(): void {
  ui.memberList.replaceChildren(...sortedMembers().map(createMemberRow));
  applyEmptyState();
  ui.peopleCount.textContent = `${members.length} ${members.length === 1 ? "member" : "members"}`;
  updateActiveCount();
}

function updateActiveCount(): void {
  const count = members.filter((member) => member.presence === "active").length;
  ui.activeCount.textContent = `${count} active`;
}

function setChannelControlsEnabled(enabled: boolean): void {
  ui.channelToggle.disabled = !enabled;
  ui.refresh.disabled = !enabled;
}

function patchPresence(reply: PresenceReply): void {
  const member = members.find(({ id }) => id === reply.userId);
  if (!member || member.presence === reply.presence) return;
  member.presence = reply.presence;

  const row = ui.memberList.querySelector<HTMLButtonElement>(
    `[data-member-id="${CSS.escape(member.id)}"]`,
  );
  const dot = row?.querySelector<HTMLElement>(".presence-dot");
  if (row && dot) {
    dot.className = `presence-dot ${reply.presence}`;
    row.setAttribute(
      "aria-label",
      `${member.displayName}, ${member.title || "no title"}, ${reply.presence}. Open direct message`,
    );
  }

  for (const sorted of sortedMembers()) {
    const sortedRow = ui.memberList.querySelector(
      `[data-member-id="${CSS.escape(sorted.id)}"]`,
    );
    if (sortedRow) ui.memberList.append(sortedRow);
  }
  updateActiveCount();
  ui.freshness.textContent = "Updated just now";
  hideBanner();
}

function renderSkeleton(): void {
  const rows = Array.from({ length: 6 }, () => {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.innerHTML = "<i></i><span><b></b><em></em></span>";
    return row;
  });
  ui.memberList.replaceChildren(...rows);
  ui.emptyState.hidden = true;
}

function renderWorkspaceOptions(): void {
  const nodes = workspaces.map((workspace) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-option";
    button.role = "option";
    button.dataset.selected = String(workspace.teamId === activeTeamId);

    const avatar = document.createElement("span");
    avatar.className = "workspace-avatar";
    avatar.textContent = workspace.teamName.charAt(0).toUpperCase() || "?";

    const copy = document.createElement("span");
    copy.className = "workspace-copy";
    const name = document.createElement("strong");
    name.textContent = workspace.teamName;
    copy.append(name);
    if (!workspace.connected) {
      const badge = document.createElement("small");
      badge.textContent = "Reconnect required";
      copy.append(badge);
    }

    button.append(avatar, copy);
    if (workspace.teamId === activeTeamId) {
      const check = document.createElement("i");
      check.textContent = "✓";
      button.append(check);
    }
    button.addEventListener("click", () => void selectWorkspace(workspace.teamId));
    return button;
  });
  ui.workspaceOptions.replaceChildren(...nodes);
}

function renderChannelOptions(query = ""): void {
  const needle = query.trim().toLocaleLowerCase();
  const options = channels.filter((channel) => channel.name.toLocaleLowerCase().includes(needle));
  const nodes = options.map((channel) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "channel-option";
    button.role = "option";
    button.dataset.selected = String(channel.id === selectedChannelId);
    button.innerHTML = `<span>${channel.isPrivate ? "⌑" : "#"}</span>`;
    const name = document.createElement("strong");
    name.textContent = channel.name;
    button.append(name);
    if (channel.id === selectedChannelId) {
      const check = document.createElement("i");
      check.textContent = "✓";
      button.append(check);
    }
    button.addEventListener("click", () => void selectChannel(channel.id));
    return button;
  });

  if (nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "channel-empty";
    empty.textContent = workspaceIsLive() ? "No matching channels" : "Connect Slack to load channels";
    ui.channelOptions.replaceChildren(empty);
  } else {
    ui.channelOptions.replaceChildren(...nodes);
  }
}

function renderConnectionSettings(): void {
  ui.alwaysOnTop.checked = status.alwaysOnTop;
  const copy = settingsCopy(
    { ...status, oauthInProgress: oauthInFlight || status.oauthInProgress },
    activeWorkspace(),
    isTauri,
  );
  ui.modeLabel.textContent = copy.modeLabel;
  ui.connectionNote.textContent = copy.connectionNote;
  ui.connect.textContent = copy.connectLabel;
  ui.connect.hidden = copy.connectHidden;
  ui.connect.disabled = copy.connectDisabled;
  ui.cancelOAuth.hidden = copy.cancelHidden;
  updateOAuthLinkControls(!copy.cancelHidden);
  ui.logout.hidden = copy.logoutHidden;
  ui.logout.textContent = copy.logoutLabel;
  ui.advancedSummary.textContent = copy.advancedSummary;
  ui.credentialsNote.textContent = copy.credentialsNote;
  ui.credentialsNote.hidden = !copy.credentialsNote;
  if (!ui.advanced.matches(":focus-within")) {
    ui.advanced.open = copy.advancedOpen;
  }
  if (document.activeElement !== ui.clientId) {
    ui.clientId.value = status.clientId;
  }
  if (document.activeElement !== ui.exchangeUrl) {
    ui.exchangeUrl.value = status.exchangeUrl;
  }
  ui.clientSecret.placeholder = status.hasClientSecret ? "Saved on this Mac" : "";
  ui.clientId.disabled = !isTauri;
  ui.clientSecret.disabled = !isTauri;
  ui.exchangeUrl.disabled = !isTauri;
  ui.saveCredentials.disabled = !isTauri;
}

function showDisconnectedPanel(message: string): void {
  scheduler.stop();
  members = [];
  channels = [];
  selectedChannelId = "";
  ui.channelName.textContent = "Choose a channel";
  setChannelControlsEnabled(false);
  renderChannelOptions();
  renderMembers();
  renderConnectionSettings();
  renderWorkspaceOptions();
  ui.freshness.textContent = "Reconnect required";
  showBanner(message, "error");
}

function markWorkspaceDisconnected(message: string): void {
  const workspace = activeWorkspace();
  if (workspace) workspace.connected = false;
  showDisconnectedPanel(message);
}

function handleDataError(error: unknown, fallback: string): void {
  if (error instanceof ReauthError) {
    markWorkspaceDisconnected(error.message);
    return;
  }
  members = [];
  renderMembers();
  showBanner(error instanceof Error ? error.message : fallback, "error");
}

async function loadChannelMembers(): Promise<void> {
  if (!selectedChannelId || !workspaceIsLive()) return;
  renderSkeleton();
  ui.refresh.classList.add("spinning");
  ui.refresh.disabled = true;
  try {
    members = await loadMembers(activeTeamId, selectedChannelId);
    renderMembers();
    const cadence = cadenceForMemberCount(members.length);
    ui.freshness.textContent = cadence.staleNotice
      ? "Large channel · rolling updates"
      : "Refreshing presence";
    scheduler.start(members.map(({ id }) => id));
    if (!panelVisible && !status.alwaysOnTop) scheduler.pause();
    hideBanner();
  } catch (error) {
    handleDataError(error, "Could not load channel members");
    if (!(error instanceof ReauthError)) ui.freshness.textContent = "Could not refresh";
  } finally {
    ui.refresh.classList.remove("spinning");
    if (workspaceIsLive()) ui.refresh.disabled = false;
  }
}

async function selectChannel(channelId: string): Promise<void> {
  selectedChannelId = channelId;
  const workspace = activeWorkspace();
  if (workspace) workspace.selectedChannelId = channelId;
  const channel = channels.find(({ id }) => id === channelId);
  ui.channelName.textContent = channel ? `# ${channel.name}` : "Choose a channel";
  closePopovers();
  renderChannelOptions();
  if (workspaceIsLive()) await saveSelectedChannel(activeTeamId, channelId);
  await loadChannelMembers();
}

async function selectWorkspace(teamId: string): Promise<void> {
  closePopovers();
  if (teamId === activeTeamId) return;
  scheduler.stop();
  activeTeamId = teamId;
  try {
    await setActiveWorkspace(teamId);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not switch workspaces", "error");
  }
  await loadWorkspace();
}

async function loadWorkspace(): Promise<void> {
  scheduler.stop();
  members = [];
  channels = [];
  selectedChannelId = "";
  const workspace = activeWorkspace();
  ui.workspace.textContent = workspaceLabel(workspace);
  renderWorkspaceOptions();
  renderConnectionSettings();

  if (!workspace) {
    setChannelControlsEnabled(false);
    ui.channelName.textContent = "Choose a channel";
    renderChannelOptions();
    renderMembers();
    ui.freshness.textContent = "Not connected";
    hideBanner();
    return;
  }

  if (!workspace.connected) {
    showDisconnectedPanel("Reconnect this Slack workspace to load live data.");
    return;
  }

  setChannelControlsEnabled(true);
  try {
    channels = await listChannels(activeTeamId);
  } catch (error) {
    ui.channelName.textContent = "Choose a channel";
    renderChannelOptions();
    handleDataError(error, "Could not load channels");
    if (!(error instanceof ReauthError)) {
      setChannelControlsEnabled(true);
      ui.freshness.textContent = "Could not load channels";
    }
    return;
  }

  const preferred = workspace.selectedChannelId;
  const selected = channels.find(({ id }) => id === preferred) ?? channels[0];
  renderChannelOptions();
  if (selected) await selectChannel(selected.id);
  else {
    ui.channelName.textContent = "No channels found";
    members = [];
    renderMembers();
    ui.freshness.textContent = "No channels";
  }
}

function setPopover(name: "workspaces" | "channels" | "settings"): void {
  const workspacesOpen = name === "workspaces" && ui.workspacePopover.hidden;
  const channelsOpen = name === "channels" && ui.channelPopover.hidden;
  const settingsOpen = name === "settings" && ui.settingsPopover.hidden;
  ui.workspacePopover.hidden = !workspacesOpen;
  ui.channelPopover.hidden = !channelsOpen;
  ui.settingsPopover.hidden = !settingsOpen;
  ui.workspaceToggle.setAttribute("aria-expanded", String(workspacesOpen));
  ui.channelToggle.setAttribute("aria-expanded", String(channelsOpen));
  ui.settingsToggle.setAttribute("aria-expanded", String(settingsOpen));
  if (workspacesOpen) renderWorkspaceOptions();
  if (channelsOpen) {
    ui.channelSearch.value = "";
    renderChannelOptions();
    window.setTimeout(() => ui.channelSearch.focus(), 0);
  }
}

function openSettingsPanel(): void {
  ui.workspacePopover.hidden = true;
  ui.channelPopover.hidden = true;
  ui.settingsPopover.hidden = false;
  ui.workspaceToggle.setAttribute("aria-expanded", "false");
  ui.channelToggle.setAttribute("aria-expanded", "false");
  ui.settingsToggle.setAttribute("aria-expanded", "true");
  ui.advanced.open = true;
  renderConnectionSettings();
  window.setTimeout(() => ui.clientId.focus(), 0);
}

function closePopovers(): void {
  ui.workspacePopover.hidden = true;
  ui.channelPopover.hidden = true;
  ui.settingsPopover.hidden = true;
  ui.workspaceToggle.setAttribute("aria-expanded", "false");
  ui.channelToggle.setAttribute("aria-expanded", "false");
  ui.settingsToggle.setAttribute("aria-expanded", "false");
}

async function handleMemberClick(member: Member): Promise<void> {
  if (!isTauri) {
    showToast("Direct messages open from the macOS app");
    return;
  }
  try {
    await openDm(activeTeamId, member.id);
    showToast(`Opening a DM with ${member.displayName}`);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not open Slack", "error");
  }
}

document.querySelector<HTMLElement>(".titlebar")?.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest("button, input, a")) return;
  void startWindowDrag();
});

async function beginOAuth(): Promise<boolean> {
  if (oauthInFlight) {
    showToast("Finish signing in with Slack in your browser");
    return true;
  }
  try {
    oauthInFlight = true;
    oauthAuthorizeUrl = "";
    status.oauthInProgress = true;
    renderConnectionSettings();
    applyEmptyState();
    await startOAuth();
    showBanner("Finish signing in with Slack in your browser. This window will connect on its own.", "info");
    return true;
  } catch (error) {
    oauthInFlight = false;
    oauthAuthorizeUrl = "";
    status.oauthInProgress = false;
    showBanner(error instanceof Error ? error.message : "Could not start OAuth", "error");
    renderConnectionSettings();
    applyEmptyState();
    return false;
  }
}

async function handleConnectClick(): Promise<void> {
  const workspace = activeWorkspace();
  if (workspace?.connected) {
    showToast(`Already connected to ${workspace.teamName}`);
    return;
  }
  if (!status.credentialsConfigured) {
    const saved = await persistCredentialsFromForm();
    if (!saved) {
      openSettingsPanel();
      return;
    }
  }
  ui.connect.disabled = true;
  ui.connect.textContent = "Opening browser…";
  ui.emptyConnect.disabled = true;
  ui.emptyConnect.textContent = "Opening browser…";
  const started = await beginOAuth();
  if (!started) return;
}

async function persistCredentialsFromForm(): Promise<boolean> {
  if (!isTauri) return false;
  const clientId = ui.clientId.value.trim();
  const clientSecret = ui.clientSecret.value.trim();
  const exchangeUrl = ui.exchangeUrl.value.trim();
  if (!clientId) return false;
  if (!clientSecret && !status.hasClientSecret && !exchangeUrl) return false;
  try {
    await saveSlackCredentials({
      clientId,
      clientSecret: clientSecret || undefined,
      exchangeUrl: exchangeUrl || undefined,
    });
    ui.clientSecret.value = "";
    status = await getAppStatus();
    applyStatus();
    renderConnectionSettings();
    applyEmptyState();
    return status.credentialsConfigured;
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not save credentials", "error");
    return false;
  }
}

async function handleCancelOAuth(): Promise<void> {
  try {
    await cancelOAuth();
  } catch (error) {
    oauthInFlight = false;
    status.oauthInProgress = false;
    showBanner(error instanceof Error ? error.message : "Could not cancel", "error");
    renderConnectionSettings();
    applyEmptyState();
  }
}

ui.workspaceToggle.addEventListener("click", () => setPopover("workspaces"));
ui.channelToggle.addEventListener("click", () => {
  if (ui.channelToggle.disabled) return;
  setPopover("channels");
});
ui.settingsToggle.addEventListener("click", () => setPopover("settings"));
ui.channelSearch.addEventListener("input", () => renderChannelOptions(ui.channelSearch.value));
ui.refresh.addEventListener("click", () => {
  if (workspaceIsLive() && (channels.length === 0 || !selectedChannelId)) {
    void loadWorkspace();
    return;
  }
  void loadChannelMembers();
});
ui.hidePanel.addEventListener("click", () => void hidePanel());

ui.addWorkspace.addEventListener("click", () => {
  closePopovers();
  if (!isTauri) {
    showToast("Adding workspaces is available in the macOS desktop app");
    return;
  }
  if (!status.credentialsConfigured) {
    openSettingsPanel();
    return;
  }
  void beginOAuth();
});

ui.alwaysOnTop.addEventListener("change", async () => {
  const previous = status.alwaysOnTop;
  status.alwaysOnTop = ui.alwaysOnTop.checked;
  try {
    await setAlwaysOnTop(status.alwaysOnTop);
    if (status.alwaysOnTop) scheduler.resume();
    showToast(status.alwaysOnTop ? "Panel will stay on top" : "Always-on-top turned off");
  } catch (error) {
    status.alwaysOnTop = previous;
    ui.alwaysOnTop.checked = previous;
    showBanner(error instanceof Error ? error.message : "Could not update window", "error");
  }
});

ui.connect.addEventListener("click", (event) => {
  event.stopPropagation();
  void handleConnectClick();
});
ui.emptyConnect.addEventListener("click", (event) => {
  event.stopPropagation();
  if (!status.credentialsConfigured) {
    openSettingsPanel();
    return;
  }
  void handleConnectClick();
});
ui.cancelOAuth.addEventListener("click", () => void handleCancelOAuth());
ui.emptyCancel.addEventListener("click", () => void handleCancelOAuth());
async function copyOAuthLink(input: HTMLInputElement): Promise<void> {
  if (!oauthAuthorizeUrl) return;
  try {
    await navigator.clipboard.writeText(oauthAuthorizeUrl);
    showToast("Slack link copied");
  } catch {
    input.focus();
    input.select();
    showToast("Slack link selected");
  }
}
ui.copyOauthLink.addEventListener("click", () => void copyOAuthLink(ui.oauthLink));
ui.copySettingsOauthLink.addEventListener("click", () => void copyOAuthLink(ui.settingsOauthLink));
ui.saveCredentials.addEventListener("click", async () => {
  const saved = await persistCredentialsFromForm();
  if (saved) showToast("Credentials saved");
});

ui.logout.addEventListener("click", async () => {
  const workspaceName = activeWorkspace()?.teamName ?? "workspace";
  try {
    await disconnectWorkspace(activeTeamId);
    status = await getAppStatus();
    applyStatus();
    closePopovers();
    await loadWorkspace();
    showToast(`Disconnected ${workspaceName}`);
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not disconnect", "error");
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (
    !ui.workspacePopover.contains(target) &&
    !ui.workspaceToggle.contains(target) &&
    !ui.channelPopover.contains(target) &&
    !ui.channelToggle.contains(target) &&
    !ui.settingsPopover.contains(target) &&
    !ui.settingsToggle.contains(target) &&
    !ui.emptyConnect.contains(target) &&
    !ui.emptyCancel.contains(target)
  ) {
    closePopovers();
  }
});

async function initialize(): Promise<void> {
  renderSkeleton();
  try {
    status = await getAppStatus();
    applyStatus();
    await loadWorkspace();
  } catch (error) {
    status = { ...EMPTY_STATUS };
    applyStatus();
    await loadWorkspace();
    showBanner(error instanceof Error ? error.message : "Could not start the app", "error");
  }

  await listenForOAuth(async (event) => {
    oauthInFlight = false;
    oauthAuthorizeUrl = "";
    status.oauthInProgress = false;
    if (!event.ok) {
      if (/cancell?ed/i.test(event.message)) {
        hideBanner();
        showToast("Slack authorization cancelled");
      } else {
        showBanner(event.message, "error");
      }
      renderConnectionSettings();
      applyEmptyState();
      return;
    }
    status = await getAppStatus();
    applyStatus();
    closePopovers();
    await loadWorkspace();
    hideBanner();
    showToast(`Connected to ${activeWorkspace()?.teamName ?? "Slack"}`);
  });

  await listenForAuthorizeUrl((url) => {
    oauthAuthorizeUrl = url;
    applyEmptyState();
  });

  await listenForPanelVisibility(({ visible }) => {
    panelVisible = visible;
    if (!visible && !status.alwaysOnTop) scheduler.pause();
    else scheduler.resume();
  });

  await listenForTrayConnect(async () => {
    status = await getAppStatus();
    applyStatus();
    if (!status.credentialsConfigured) {
      openSettingsPanel();
      return;
    }
    closePopovers();
    void beginOAuth();
  });

  await listenForTraySettings(() => {
    openSettingsPanel();
  });
}

void initialize();
