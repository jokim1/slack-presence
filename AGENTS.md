# Presence for Slack

- Stack: Tauri 2 Rust shell with a framework-free TypeScript/Vite frontend.
- Slack OAuth, Web API calls, Keychain storage, tray behavior, and native deep links live in `src-tauri/src`.
- The Tier-3-aware presence scheduler lives in `src/presence-scheduler.ts`; UI orchestration is in `src/main.ts`.
- Run the unconnected UI preview with `npm install && npm run dev`. Run the desktop app with `npm run tauri dev` after installing Rust and the prerequisites in `SETUP.md`. Local unsigned `.app`/`.dmg`: `npm run tauri build` (Rust stable on PATH; output in `src-tauri/target/release/bundle/`). The only data source is Slack OAuth + Web API through the Rust backend; there is no demo dataset.
- Validate changes with `npm test`, `npm run typecheck`, `npm run build`, and `cargo check --manifest-path src-tauri/Cargo.toml`.
- Never log or move Slack OAuth tokens into frontend storage. `xoxp` tokens belong only in macOS Keychain, one entry per connected workspace (see `src-tauri/src/lib.rs`).
- One-click Slack login uses a public client ID in the app plus `oauth-worker/` for the code exchange. The client secret is a Worker secret, never shipped in the app. Bring-your-own credentials are an in-app Settings path (no `.env` restart).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
