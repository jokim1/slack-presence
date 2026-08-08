# Presence for Slack

A lightweight macOS menu-bar companion that keeps the people in one selected Slack channel visible, shows Slack's active/away presence, and opens a direct message with one click.

The app is mock-first: it opens with demo people and channels before any Slack credentials are configured. Once connected, it uses only Slack's official OAuth and Web APIs. Presence is the same coarse `active` or `away` signal Slack exposes. A channel must be selected manually because Slack does not expose the channel currently focused in its desktop app.

## Run the demo UI

```sh
npm install
npm run dev
```

Open the printed localhost URL. Native-only actions such as OAuth, Keychain access, the tray icon, and Slack deep links require the Tauri app.

## Run the macOS app

Install the current stable Rust toolchain and Apple's Xcode Command Line Tools, then follow [SETUP.md](SETUP.md) if you want to connect a real workspace.

```sh
npm install
npm run tauri dev
```

Without `.env`, the desktop app also starts in mock mode. Useful validation commands:

```sh
npm test
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

The first unsigned local build may prompt macOS to allow Keychain access. Packaging, signing, notarization, token rotation, and multi-workspace installs are outside the Phase 1 MVP.

## Privacy and security

The Slack user token is stored only in macOS Keychain. It is never sent to the frontend, placed in `localStorage`, or logged. Local app credentials come from a gitignored `.env` file. The app does not read Slack cookies, use internal Slack endpoints, send messages, or request `chat:write`.

Not affiliated with or endorsed by Slack Technologies / Salesforce. Slack is a trademark of Salesforce.
