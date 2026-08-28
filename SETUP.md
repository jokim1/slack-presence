# Connect Presence for Slack to a workspace

Click **Connect Slack** in the app. Slack's authorization page opens in your browser. Sign in (and complete 2FA if asked). Slack returns to the shared HTTPS worker, which relays the callback to the app's local loopback listener. The app validates OAuth `state` and stores the user token in macOS Keychain. You do not paste a link or token, and you do not restart the app.

Until a workspace is connected, the panel shows a connect empty state. While Slack's page is open, the panel shows that it is waiting and a **Cancel** control. If a workspace is already connected, Connect is not offered again for that workspace; use **Add a workspace** in the switcher to connect another one.

If your workspace requires admin approval, Slack will keep the install pending until an administrator approves it. If you change scopes later, reconnect the app so Slack grants the updated set.

## Connect more workspaces (optional)

Click the workspace name under the panel title and choose **Add a workspace**. On Slack's authorization page, use the workspace picker in the top-right corner to select the other workspace before approving.

A Slack app can only be installed to workspaces beyond the one it was created in after distribution is enabled: in the app settings, open **Manage Distribution**, complete the checklist, and choose **Activate Public Distribution**.

The shared Slack app must register this exact HTTPS redirect URL:

```text
https://presence-for-slack-oauth.jokim1.workers.dev/oauth/callback
```

The app stores one `xoxp` token per workspace in macOS Keychain and remembers each workspace's selected channel. Switch between workspaces from the same menu; **Disconnect** in settings removes only the active workspace.

Disconnecting a workspace removes its Keychain token and returns that slot to a reconnect/empty state. It does not invent sample people. If Slack returns `token_revoked`, `token_expired`, `invalid_auth`, a missing user scope, or a network failure, the panel shows that error and a reconnect action instead of falling back to local data.

## Advanced / self-hosting

Use this path if you are running your own Slack app, or if this build does not yet include the shared app (Settings then shows credential fields instead of a dead Connect button).

### Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and choose **Create New App**.
2. Choose **From scratch**.
3. Name the app `Presence for Slack`, select the workspace you want to use, and create it. Public distribution is not required unless you want to install it on other workspaces.

### Add the user scopes

1. Open **OAuth & Permissions** in the app settings.
2. Under **Scopes > User Token Scopes**, add exactly:
   - `users:read`
   - `channels:read`
   - `groups:read`
   - `im:read`
   - `mpim:read`
3. Do not add bot scopes or `chat:write`. This app opens Slack with a deep link and never sends messages.

### Register the callback

Under **OAuth & Permissions > Redirect URLs**, add this exact URL and save it:

```text
http://127.0.0.1:53641/oauth/callback
```

Slack requires the `redirect_uri` used during authorization and code exchange to exactly match this value. The app listens only on loopback for the callback and validates the OAuth `state` value.

### Paste credentials in the app

Open **Settings** in Presence for Slack and use **Use your own Slack app** (or the credential fields shown when one-click is unavailable). Paste the **Client ID** and **Client Secret** from **Basic Information > App Credentials**. They are applied immediately; do not restart.

The secret stays in local app settings on this Mac. The resulting `xoxp` user token is written to macOS Keychain, never to `.env` or browser storage.

Optional: set an OAuth exchange URL if you are pointing at your own `oauth-worker/` instead of exchanging the code with Slack directly.

### Local-dev `.env` (optional)

`.env` is still read at process start for development only. Copy `.env.example` if you want that override. Changing `.env` still requires a restart; the in-app Settings fields do not.

```dotenv
PRESENCE_SLACK_CLIENT_ID=your-client-id
PRESENCE_SLACK_CLIENT_SECRET=your-client-secret
PRESENCE_SLACK_OAUTH_EXCHANGE_URL=http://127.0.0.1:8787/oauth/exchange
PRESENCE_SLACK_REDIRECT_URI=http://127.0.0.1:53641/oauth/callback
```

Do not commit `.env` or share its client secret.

### Hosted exchange worker

The shared one-click path keeps the Slack client secret in a Cloudflare Worker (`oauth-worker/`). The desktop app holds only the public client ID, sends the OAuth code to the worker, and stores the returned user token in Keychain. The worker does not store tokens. Deploy steps live in `oauth-worker/wrangler.toml`.
