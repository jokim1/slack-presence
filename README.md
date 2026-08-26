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

Install the current stable Rust toolchain and Apple's Xcode Command Line Tools. Then:

```sh
npm install
npm run tauri dev
```

Click **Connect Slack**. Slack's own OAuth runs in the browser, including any 2FA. When you approve, the app finishes connecting on its own. No `.env` file and no restart.

The shared Slack app plus the hosted exchange worker must be configured for that one-click path. If this build does not include them yet, Settings shows Client ID and Secret fields (applied immediately, no restart). Creating your own Slack app is documented under **Advanced / self-hosting** in [SETUP.md](SETUP.md). `.env` remains a local-dev override only.

Useful validation commands:

```sh
npm test
npm run typecheck
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

The first unsigned local build may prompt macOS to allow Keychain access. Packaging, signing, notarization, and token rotation are outside the current phase.

## Privacy and security

Slack user tokens are stored only in macOS Keychain, one entry per connected workspace. They are never sent to the frontend, placed in `localStorage`, or logged. The shared Slack app's client secret lives only in the Cloudflare Worker that exchanges the OAuth code. The resulting `xoxp` user token is passed back to the app once and written to Keychain. The app does not read Slack cookies, use internal Slack endpoints, send messages, or request `chat:write`.

Not affiliated with or endorsed by Slack Technologies / Salesforce. Slack is a trademark of Salesforce.
