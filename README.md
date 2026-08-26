# Presence for Slack

A lightweight macOS menu-bar companion that keeps the people in one selected Slack channel visible, shows Slack's active/away presence, and opens a direct message with one click.

The app uses only Slack's official OAuth and Web APIs. Until a workspace is connected, the panel shows an onboarding/connect empty state rather than sample people. Presence is the same coarse `active` or `away` signal Slack exposes. A channel must be selected manually because Slack does not expose the channel currently focused in its desktop app.

Multiple workspaces are supported: connect each one through **Add a workspace** in the switcher under the panel title, and switch between them there. Each workspace keeps its own user token in macOS Keychain and remembers its own selected channel.

## Preview the UI in a browser

```sh
npm install
npm run dev
```

Open the printed localhost URL. That preview cannot talk to Slack; it shows the unconnected empty state. OAuth, Keychain access, the tray icon, and Slack deep links require the Tauri app.

## Run the macOS app

Install the current stable Rust toolchain and Apple's Xcode Command Line Tools, then follow [SETUP.md](SETUP.md) to create a Slack app and add local credentials.

```sh
npm install
npm run tauri dev
```

Without `.env`, the desktop app stays on the connect empty state until you add Client ID and Secret and restart. Useful validation commands:

```sh
npm test
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

The first unsigned local build may prompt macOS to allow Keychain access. Packaging, signing, notarization, and token rotation are outside the current phase.

## Privacy and security

Slack user tokens are stored only in macOS Keychain, one entry per connected workspace. They are never sent to the frontend, placed in `localStorage`, or logged. Local app credentials come from a gitignored `.env` file. The app does not read Slack cookies, use internal Slack endpoints, send messages, or request `chat:write`.

Not affiliated with or endorsed by Slack Technologies / Salesforce. Slack is a trademark of Salesforce.
