# Presence for Slack

- Stack: Tauri 2 Rust shell with a framework-free TypeScript/Vite frontend.
- Slack OAuth, Web API calls, Keychain storage, tray behavior, and native deep links live in `src-tauri/src`.
- The Tier-3-aware presence scheduler lives in `src/presence-scheduler.ts`; UI orchestration is in `src/main.ts`.
- Run the mock-first UI with `npm install && npm run dev`. Run the desktop app with `npm run tauri dev` after installing Rust and the prerequisites in `SETUP.md`.
- Validate changes with `npm test`, `npm run typecheck`, `npm run build`, and `cargo check --manifest-path src-tauri/Cargo.toml`.
- Never log or move Slack OAuth tokens into frontend storage. The `xoxp` token belongs only in macOS Keychain.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
