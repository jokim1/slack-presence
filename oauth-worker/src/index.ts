export interface Env {
  SLACK_CLIENT_ID: string;
  SLACK_CLIENT_SECRET: string;
  SLACK_API_BASE?: string;
}

export type SlackFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

interface ExchangeBody {
  code?: unknown;
  redirect_uri?: unknown;
}

interface SlackOAuthResponse {
  ok?: unknown;
  error?: unknown;
  authed_user?: {
    access_token?: unknown;
  };
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function slackApiBase(env: Env): string {
  const base = env.SLACK_API_BASE?.trim() || "https://slack.com/api";
  return base.replace(/\/$/, "");
}

export function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/oauth/callback"
    );
  } catch {
    return false;
  }
}

function readToken(payload: SlackOAuthResponse): string | undefined {
  const token = payload.authed_user?.access_token;
  return typeof token === "string" && token.startsWith("xoxp-") ? token : undefined;
}

export async function handleRequest(
  request: Request,
  env: Env,
  slackFetch: SlackFetcher = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/oauth/exchange") {
    return json(404, { ok: false, error: "not_found" });
  }

  const clientId = env.SLACK_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) {
    return json(503, { ok: false, error: "oauth_not_configured" });
  }

  let body: ExchangeBody;
  try {
    body = (await request.json()) as ExchangeBody;
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const redirectUri =
    typeof body.redirect_uri === "string" ? body.redirect_uri.trim() : "";
  if (!code || !redirectUri) {
    return json(400, { ok: false, error: "missing_code_or_redirect_uri" });
  }
  if (!isAllowedRedirect(redirectUri)) {
    return json(400, { ok: false, error: "invalid_redirect_uri" });
  }

  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  let slackResponse: Response;
  try {
    slackResponse = await slackFetch(`${slackApiBase(env)}/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch {
    return json(502, { ok: false, error: "slack_unreachable" });
  }

  let payload: SlackOAuthResponse;
  try {
    payload = (await slackResponse.json()) as SlackOAuthResponse;
  } catch {
    return json(502, { ok: false, error: "slack_invalid_response" });
  }

  if (payload.ok !== true) {
    const error =
      typeof payload.error === "string" && payload.error ? payload.error : "unknown_error";
    return json(400, { ok: false, error });
  }

  const accessToken = readToken(payload);
  if (!accessToken) {
    return json(502, { ok: false, error: "missing_user_token" });
  }

  return json(200, { ok: true, access_token: accessToken });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
