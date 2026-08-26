import "./styles.css";
import {
  getAppStatus,
  getPresence,
  hidePanel,
  isTauri,
  listChannels,
  listenForOAuth,
  listenForPanelVisibility,
  loadMembers,
  logout,
  openDm,
  saveSelectedChannel,
  setAlwaysOnTop,
  startOAuth,
  startWindowDrag,
} from "./native-api";
import { cadenceForMemberCount, PresenceScheduler } from "./presence-scheduler";
import type { AppStatus, Channel, Member, PresenceReply } from "./types";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root is missing");

app.innerHTML = `
  <div class="app-shell">
    <header class="titlebar" data-tauri-drag-region>
      <div class="brand-mark" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <div class="brand-copy" data-tauri-drag-region>
        <strong>Presence</strong>
        <span id="workspace-name">Starting up…</span>
      </div>
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
        <span id="mode-label">Demo workspace</span>
      </div>
      <label class="toggle-row">
        <span><strong>Keep panel on top</strong><small>Stay visible above other windows</small></span>
        <input id="always-on-top" type="checkbox" role="switch" />
      </label>
      <div class="settings-divider"></div>
      <p class="settings-note" id="connection-note"></p>
      <button class="primary-button" id="connect-button">Connect Slack</button>
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
        <strong>No people to show</strong>
        <p>This channel may be empty or its members are bots and deactivated accounts.</p>
      </div>
    </main>

    <footer class="footer">
      <span class="active-summary"><i></i><span id="active-count">0 active</span></span>
      <span id="freshness">Demo data</span>
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
  logout: element<HTMLButtonElement>("#logout-button"),
  refresh: element<HTMLButtonElement>("#refresh"),
  hidePanel: element<HTMLButtonElement>("#hide-panel"),
  banner: element<HTMLElement>("#status-banner"),
  memberList: element<HTMLElement>("#member-list"),
  emptyState: element<HTMLElement>("#empty-state"),
  peopleCount: element<HTMLElement>("#people-count"),
  activeCount: element<HTMLElement>("#active-count"),
  freshness: element<HTMLElement>("#freshness"),
  toast: element<HTMLElement>("#toast"),
};

let status: AppStatus;
let channels: Channel[] = [];
let members: Member[] = [];
let selectedChannelId = "";
let useMock = true;
let panelVisible = true;
let toastTimer: number | undefined;

const scheduler = new PresenceScheduler({
  request: (userId) => getPresence(userId, useMock),
  onChange: patchPresence,
  onRateLimit: (seconds) => {
    showBanner(`Slack is rate limiting presence checks. Retrying in ${seconds}s.`, "warning");
    ui.freshness.textContent = "Presence paused";
  },
  onError: (error) => {
    showBanner(error.message, "error");
    ui.freshness.textContent = "Last-known presence";
  },
});

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

function renderMembers(): void {
  ui.memberList.replaceChildren(...sortedMembers().map(createMemberRow));
  ui.emptyState.hidden = members.length > 0;
  ui.peopleCount.textContent = `${members.length} ${members.length === 1 ? "member" : "members"}`;
  updateActiveCount();
}

function updateActiveCount(): void {
  const count = members.filter((member) => member.presence === "active").length;
  ui.activeCount.textContent = `${count} active`;
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
    row.innerHTML = '<i></i><span><b></b><em></em></span>';
    return row;
  });
  ui.memberList.replaceChildren(...rows);
  ui.emptyState.hidden = true;
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
    empty.textContent = "No matching channels";
    ui.channelOptions.replaceChildren(empty);
  } else {
    ui.channelOptions.replaceChildren(...nodes);
  }
}

function renderConnectionSettings(): void {
  ui.alwaysOnTop.checked = status.alwaysOnTop;
  ui.logout.hidden = !status.authenticated;
  if (status.authenticated) {
    ui.modeLabel.textContent = status.teamName ?? "Connected workspace";
    ui.connectionNote.textContent = "Connected with a user token stored in macOS Keychain.";
    ui.connect.textContent = "Reconnect Slack";
    ui.connect.disabled = false;
    return;
  }

  ui.modeLabel.textContent = "Demo workspace";
  ui.connect.textContent = "Connect Slack";
  if (!isTauri) {
    ui.connectionNote.textContent = "OAuth and Keychain access are available in the macOS desktop app.";
    ui.connect.disabled = true;
  } else if (!status.credentialsConfigured) {
    ui.connectionNote.textContent = "Add your Client ID and Secret to .env, then restart the app. See SETUP.md.";
    ui.connect.disabled = true;
  } else {
    ui.connectionNote.textContent = "Your local app credentials are ready. Connect to replace demo data.";
    ui.connect.disabled = false;
  }
}

async function loadChannelMembers(): Promise<void> {
  if (!selectedChannelId) return;
  renderSkeleton();
  ui.refresh.classList.add("spinning");
  ui.refresh.disabled = true;
  try {
    members = await loadMembers(selectedChannelId, useMock);
    renderMembers();
    const cadence = cadenceForMemberCount(members.length);
    ui.freshness.textContent = cadence.staleNotice
      ? "Large channel · rolling updates"
      : useMock
        ? "Demo data"
        : "Refreshing presence";
    scheduler.start(members.map(({ id }) => id));
    if (!panelVisible && !status.alwaysOnTop) scheduler.pause();
    hideBanner();
  } catch (error) {
    members = [];
    renderMembers();
    showBanner(error instanceof Error ? error.message : "Could not load channel members", "error");
  } finally {
    ui.refresh.classList.remove("spinning");
    ui.refresh.disabled = false;
  }
}

async function selectChannel(channelId: string): Promise<void> {
  selectedChannelId = channelId;
  const channel = channels.find(({ id }) => id === channelId);
  ui.channelName.textContent = channel ? `# ${channel.name}` : "Choose a channel";
  closePopovers();
  renderChannelOptions();
  if (!useMock) await saveSelectedChannel(channelId);
  await loadChannelMembers();
}

async function loadWorkspace(): Promise<void> {
  scheduler.stop();
  useMock = !status.authenticated;
  ui.workspace.textContent = useMock ? "Demo · Acme Studio" : status.teamName ?? "Slack workspace";
  channels = await listChannels(useMock);
  const preferred = status.selectedChannelId;
  const selected = channels.find(({ id }) => id === preferred) ?? channels[0];
  selectedChannelId = selected?.id ?? "";
  renderConnectionSettings();
  renderChannelOptions();
  if (selected) await selectChannel(selected.id);
  else {
    ui.channelName.textContent = "No channels found";
    members = [];
    renderMembers();
  }
}

function setPopover(name: "channels" | "settings"): void {
  const channelsOpen = name === "channels" && ui.channelPopover.hidden;
  const settingsOpen = name === "settings" && ui.settingsPopover.hidden;
  ui.channelPopover.hidden = !channelsOpen;
  ui.settingsPopover.hidden = !settingsOpen;
  ui.channelToggle.setAttribute("aria-expanded", String(channelsOpen));
  ui.settingsToggle.setAttribute("aria-expanded", String(settingsOpen));
  if (channelsOpen) {
    ui.channelSearch.value = "";
    renderChannelOptions();
    window.setTimeout(() => ui.channelSearch.focus(), 0);
  }
}

function closePopovers(): void {
  ui.channelPopover.hidden = true;
  ui.settingsPopover.hidden = true;
  ui.channelToggle.setAttribute("aria-expanded", "false");
  ui.settingsToggle.setAttribute("aria-expanded", "false");
}

async function handleMemberClick(member: Member): Promise<void> {
  if (useMock || !status.teamId) {
    showToast("DM deep links are ready in the connected desktop app");
    return;
  }
  try {
    await openDm(status.teamId, member.id);
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

ui.channelToggle.addEventListener("click", () => setPopover("channels"));
ui.settingsToggle.addEventListener("click", () => setPopover("settings"));
ui.channelSearch.addEventListener("input", () => renderChannelOptions(ui.channelSearch.value));
ui.refresh.addEventListener("click", () => void loadChannelMembers());
ui.hidePanel.addEventListener("click", () => void hidePanel());

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

ui.connect.addEventListener("click", async () => {
  ui.connect.disabled = true;
  ui.connect.textContent = "Opening browser…";
  try {
    await startOAuth();
    showToast("Finish authorization in your browser");
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not start OAuth", "error");
    renderConnectionSettings();
  }
});

ui.logout.addEventListener("click", async () => {
  try {
    await logout();
    status = await getAppStatus();
    closePopovers();
    await loadWorkspace();
    showToast("Disconnected. Showing demo data.");
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not disconnect", "error");
  }
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (
    !ui.channelPopover.contains(target) &&
    !ui.channelToggle.contains(target) &&
    !ui.settingsPopover.contains(target) &&
    !ui.settingsToggle.contains(target)
  ) {
    closePopovers();
  }
});

async function initialize(): Promise<void> {
  renderSkeleton();
  try {
    status = await getAppStatus();
    await loadWorkspace();
  } catch (error) {
    showBanner(error instanceof Error ? error.message : "Could not start the app", "error");
  }

  await listenForOAuth(async (event) => {
    if (!event.ok) {
      showBanner(event.message, "error");
      renderConnectionSettings();
      return;
    }
    status = await getAppStatus();
    closePopovers();
    await loadWorkspace();
    showToast(`Connected to ${status.teamName ?? "Slack"}`);
  });

  await listenForPanelVisibility(({ visible }) => {
    panelVisible = visible;
    if (!visible && !status.alwaysOnTop) scheduler.pause();
    else scheduler.resume();
  });
}

void initialize();
