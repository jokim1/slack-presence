import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { handleRequest, isAllowedRedirect, type Env } from "./index";

const HTTPS_REDIRECT =
  "https://presence-for-slack-oauth.jokim1.workers.dev/oauth/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1:53641/oauth/callback";

const env: Env = {
  SLACK_CLIENT_ID: "123.456",
  SLACK_CLIENT_SECRET: "super-secret",
};

function exchangeRequest(body: unknown): Request {
  return new Request("https://worker.test/oauth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("isAllowedRedirect", () => {
  it("accepts the public HTTPS and legacy loopback callbacks", () => {
    expect(isAllowedRedirect(HTTPS_REDIRECT)).toBe(true);
    expect(isAllowedRedirect(LOOPBACK_REDIRECT)).toBe(true);
  });

  it("rejects callbacks outside the exact hosted or loopback routes", () => {
    expect(isAllowedRedirect("https://example.com/oauth/callback")).toBe(false);
    expect(isAllowedRedirect("http://localhost:53641/oauth/callback")).toBe(false);
    expect(isAllowedRedirect("http://127.0.0.1:53641/oauth/other")).toBe(false);
  });
});

describe("handleRequest", () => {
  it("relays Slack's callback query to the app loopback", async () => {
    const response = await handleRequest(
      new Request(
        `${HTTPS_REDIRECT}?code=slack-code&state=csrf-state&team=example`,
      ),
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${LOOPBACK_REDIRECT}?code=slack-code&state=csrf-state&team=example`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("relays Slack errors and state to the app loopback", async () => {
    const response = await handleRequest(
      new Request(`${HTTPS_REDIRECT}?error=access_denied&state=csrf-state`),
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${LOOPBACK_REDIRECT}?error=access_denied&state=csrf-state`,
    );
  });

  it("rejects unknown routes", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/health"),
      env,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "not_found" });
  });

  it("requires the worker secrets", async () => {
    const response = await handleRequest(exchangeRequest({ code: "x", redirect_uri: "http://127.0.0.1:53641/oauth/callback" }), {
      SLACK_CLIENT_ID: "",
      SLACK_CLIENT_SECRET: "",
    });
    expect(response.status).toBe(503);
  });

  it("rejects a non-loopback redirect", async () => {
    const response = await handleRequest(
      exchangeRequest({
        code: "abc",
        redirect_uri: "https://evil.example/oauth/callback",
      }),
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_redirect_uri",
    });
  });

  it("exchanges a code and returns only the user token", async () => {
    const seen: { url?: string; body?: string } = {};
    const response = await handleRequest(
      exchangeRequest({
        code: "slack-code",
        redirect_uri: HTTPS_REDIRECT,
      }),
      env,
      async (url, init) => {
        seen.url = url;
        seen.body = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            ok: true,
            authed_user: { access_token: "xoxp-user-token" },
            access_token: "xoxb-must-not-leak",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      access_token: "xoxp-user-token",
    });
    expect(seen.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(seen.body).toContain("client_secret=super-secret");
    expect(seen.body).toContain("code=slack-code");
    expect(seen.body).toContain(
      "redirect_uri=https%3A%2F%2Fpresence-for-slack-oauth.jokim1.workers.dev%2Foauth%2Fcallback",
    );
  });

  it("passes Slack's error through without a token", async () => {
    const response = await handleRequest(
      exchangeRequest({
        code: "bad",
        redirect_uri: "http://127.0.0.1:53641/oauth/callback",
      }),
      env,
      async () =>
        new Response(JSON.stringify({ ok: false, error: "invalid_code" }), {
          status: 200,
        }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_code",
    });
  });

  it("rejects a bot token in the user slot", async () => {
    const response = await handleRequest(
      exchangeRequest({
        code: "bot",
        redirect_uri: "http://127.0.0.1:53641/oauth/callback",
      }),
      env,
      async () =>
        new Response(
          JSON.stringify({ ok: true, authed_user: { access_token: "xoxb-bot" } }),
          { status: 200 },
        ),
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "missing_user_token",
    });
  });
});

describe("handleRequest against a mock Slack HTTP server", () => {
  let server: Server;
  let slackBase = "";

  const listen = new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url !== "/oauth.v2.access") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        expect(body).toContain("client_id=123.456");
        expect(body).toContain("code=live-code");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            authed_user: { access_token: "xoxp-from-mock-slack" },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      slackBase = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it("posts to the mock Slack origin from SLACK_API_BASE", async () => {
    await listen;
    const response = await handleRequest(
      exchangeRequest({
        code: "live-code",
        redirect_uri: "http://127.0.0.1:53641/oauth/callback",
      }),
      { ...env, SLACK_API_BASE: slackBase },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      access_token: "xoxp-from-mock-slack",
    });
  });
});
