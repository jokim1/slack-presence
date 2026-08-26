# Connect Presence for Slack to a workspace

The app is intended for a local installation where each user supplies their own Slack app credentials. Do not commit `.env` or share its client secret.

## 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and choose **Create New App**.
2. Choose **From scratch**.
3. Name the app `Presence for Slack`, select the workspace you want to use, and create it. Public distribution is not required.

## 2. Add the user scopes

1. Open **OAuth & Permissions** in the app settings.
2. Under **Scopes > User Token Scopes**, add exactly:
   - `users:read`
   - `channels:read`
   - `groups:read`
   - `im:read`
   - `mpim:read`
3. Do not add bot scopes or `chat:write`. This app opens Slack with a deep link and never sends messages.

## 3. Register the callback

Under **OAuth & Permissions > Redirect URLs**, add this exact URL and save it:

```text
http://127.0.0.1:53641/oauth/callback
```

Slack requires the `redirect_uri` used during authorization and code exchange to exactly match this value. The app listens only on loopback for the callback and validates the OAuth `state` value.

## 4. Add local credentials

Copy the example file and open the new `.env`:

```sh
cp .env.example .env
```

From **Basic Information > App Credentials**, paste the **Client ID** and **Client Secret** into:

```dotenv
PRESENCE_SLACK_CLIENT_ID=your-client-id
PRESENCE_SLACK_CLIENT_SECRET=your-client-secret
PRESENCE_SLACK_REDIRECT_URI=http://127.0.0.1:53641/oauth/callback
```

The secret remains in the gitignored local file and process memory. The resulting `xoxp` user token is written to macOS Keychain, never to `.env` or browser storage. A distributed multi-user build would need an OAuth backend to keep a shared client secret out of the app; that is not part of this MVP.

## 5. Authorize and run

```sh
npm install
npm run tauri dev
```

Open settings in the panel, choose **Connect Slack**, and approve the user scopes. The browser returns to the local callback, after which the panel loads the channels you belong to through `users.conversations`.

If your workspace requires admin approval, Slack will keep the install pending until an administrator approves it. If you change scopes later, reconnect the app so Slack grants the updated set.

## 6. Connect more workspaces (optional)

Click the workspace name under the panel title and choose **Add a workspace**. On Slack's authorization page, use the workspace picker in the top-right corner to select the other workspace before approving.

A Slack app can only be installed to workspaces beyond the one it was created in after distribution is enabled: in the app settings, open **Manage Distribution**, complete the checklist, and choose **Activate Public Distribution**. The `.env` credentials stay the same.

The app stores one `xoxp` token per workspace in macOS Keychain and remembers each workspace's selected channel. Switch between workspaces from the same menu; **Disconnect** in settings removes only the active workspace.
