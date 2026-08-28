import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_dev, type UnstableDevWorker } from "wrangler";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

const REDIRECT =
  "https://presence-for-slack-oauth.jokim1.workers.dev/oauth/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1:53641/oauth/callback";

describe("wrangler-dev exchange against a mock Slack API", () => {
  let slack: Server;
  let slackBase = "";
  let worker: UnstableDevWorker;

  beforeAll(async () => {
    slack = await new Promise<Server>((resolve) => {
      const server = createServer((req, res) => {
        if (req.method !== "POST" || req.url !== "/oauth.v2.access") {
          res.statusCode = 404;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk as Buffer));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          res.setHeader("content-type", "application/json");
          if (!body.includes("code=wrangler-code")) {
            res.end(JSON.stringify({ ok: false, error: "invalid_code" }));
            return;
          }
          res.end(
            JSON.stringify({
              ok: true,
              authed_user: { access_token: "xoxp-wrangler-e2e" },
            }),
          );
        });
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    slackBase = `http://127.0.0.1:${(slack.address() as AddressInfo).port}`;

    worker = await unstable_dev(path.join(srcDir, "index.ts"), {
      config: path.join(srcDir, "..", "wrangler.toml"),
      experimental: { disableExperimentalWarning: true },
      vars: {
        SLACK_CLIENT_ID: "123.456",
        SLACK_CLIENT_SECRET: "test-secret",
        SLACK_API_BASE: slackBase,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await worker?.stop();
    await new Promise<void>((resolve, reject) => {
      slack.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("returns the user token from the locally-run worker", async () => {
    const response = await worker.fetch("http://worker.test/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "wrangler-code", redirect_uri: REDIRECT }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      access_token: "xoxp-wrangler-e2e",
    });
  });

  it("relays the HTTPS callback to the desktop loopback", async () => {
    const response = await worker.fetch(
      "http://worker.test/oauth/callback?code=wrangler-code&state=csrf-state",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${LOOPBACK_REDIRECT}?code=wrangler-code&state=csrf-state`,
    );
  });
});
