#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import http from "node:http";
import path from "node:path";

type RequiredEnv = {
  hooksToken: string;
  appId: string;
  appPrivateKeyPath: string;
  appWebhookSecret: string;
};

const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(homedir(), ".openclaw");
const envFile = path.join(stateDir, ".env");
const relayPort = Number(process.env.RELAY_PORT || "18990");
const relayLogPath = "/tmp/github-openclaw-relay.log";
const cloudflaredLogPath = "/tmp/cloudflared-openclaw.log";
const webhookConfigPath = "/tmp/clawengineer-webhook-config.json";
const hookTarget = process.env.OPENCLAW_HOOK_TARGET || "http://127.0.0.1:18789/hooks/github";

let relayLog = createWriteStream(relayLogPath, { flags: "a", mode: 0o600 });
let cloudflaredLog = createWriteStream(cloudflaredLogPath, { flags: "a", mode: 0o600 });

function fail(message: string): never {
  throw new Error(message);
}

function ensureBinary(name: string) {
  const probe = spawnSync("/usr/bin/env", ["bash", "-lc", `command -v ${name}`], {
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    fail(`Missing required binary: ${name}`);
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    out[key] = stripOptionalQuotes(value);
  }
  return out;
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requireEnv(env: Record<string, string>): RequiredEnv {
  const hooksToken = env.OPENCLAW_HOOKS_TOKEN?.trim();
  const appId = env.GITHUB_APP_ID?.trim();
  const appPrivateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const appWebhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  if (!hooksToken || !appId || !appPrivateKeyPath || !appWebhookSecret) {
    fail(
      `Missing required env in ${envFile}: OPENCLAW_HOOKS_TOKEN, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_WEBHOOK_SECRET`,
    );
  }
  if (!existsSync(appPrivateKeyPath)) {
    fail(`GitHub App private key file not found: ${appPrivateKeyPath}`);
  }
  return { hooksToken, appId, appPrivateKeyPath, appWebhookSecret };
}

function toBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function createGitHubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

function logRelay(message: string) {
  relayLog.write(`${message}\n`);
  process.stdout.write(`${message}\n`);
}

function killByPattern(pattern: string) {
  spawnSync("pkill", ["-f", pattern], { stdio: "ignore" });
}

function sanitizeHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(",");
  return value ?? "";
}

async function main() {
  ensureBinary("cloudflared");
  if (!existsSync(envFile)) {
    fail(`Missing env file: ${envFile}`);
  }

  const env = parseEnvFile(envFile);
  const required = requireEnv(env);

  killByPattern(`cloudflared tunnel --url http://127.0.0.1:${relayPort}`);
  killByPattern("/tmp/github-openclaw-relay.mjs");

  writeFileSync(relayLogPath, "", { encoding: "utf8", mode: 0o600 });
  writeFileSync(cloudflaredLogPath, "", { encoding: "utf8", mode: 0o600 });
  relayLog.end();
  cloudflaredLog.end();
  relayLog = createWriteStream(relayLogPath, { flags: "a", mode: 0o600 });
  cloudflaredLog = createWriteStream(cloudflaredLogPath, { flags: "a", mode: 0o600 });

  const relayServer = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);

    const headers: Record<string, string> = {
      "content-type": sanitizeHeaderValue(req.headers["content-type"]) || "application/json",
      "x-openclaw-token": required.hooksToken,
    };
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower.startsWith("x-github-") || lower === "x-hub-signature-256") {
        headers[lower] = sanitizeHeaderValue(value);
      }
    }

    try {
      const upstream = await fetch(hookTarget, {
        method: "POST",
        headers,
        body,
      });
      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.setHeader(
        "content-type",
        upstream.headers.get("content-type") || "text/plain; charset=utf-8",
      );
      res.end(text);
    } catch (error) {
      res.statusCode = 502;
      res.end(`relay_error:${String(error)}`);
    }
  });

  await new Promise<void>((resolve) => {
    relayServer.listen(relayPort, "127.0.0.1", () => {
      logRelay(`relay_listening http://127.0.0.1:${relayPort}`);
      resolve();
    });
  });

  let tunnelUrl: string | undefined;
  const tunnelRegex = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;
  const cloudflared = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${relayPort}`, "--no-autoupdate"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const onCloudflaredData = (chunk: Buffer | string) => {
    const text = String(chunk);
    cloudflaredLog.write(text);
    process.stdout.write(text);
    if (!tunnelUrl) {
      const match = text.match(tunnelRegex);
      if (match?.[0]) tunnelUrl = match[0];
    }
  };
  cloudflared.stdout?.on("data", onCloudflaredData);
  cloudflared.stderr?.on("data", onCloudflaredData);

  const waitStart = Date.now();
  while (!tunnelUrl) {
    if (Date.now() - waitStart > 90_000) {
      const recent = readFileSync(cloudflaredLogPath, "utf8").split(/\r?\n/).slice(-120).join("\n");
      fail(`Failed to get cloudflared tunnel URL.\n${recent}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const appPrivateKeyPem = readFileSync(required.appPrivateKeyPath, "utf8");
  const appJwt = createGitHubAppJwt(required.appId, appPrivateKeyPem);
  const patchPayload = {
    url: `${tunnelUrl}/github`,
    content_type: "json",
    secret: required.appWebhookSecret,
  };

  const patchResponse = await fetch("https://api.github.com/app/hook/config", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codeclaw-webhook-bridge",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchPayload),
  });
  const patchText = await patchResponse.text();
  if (!patchResponse.ok) {
    fail(`Failed to patch GitHub webhook config: HTTP ${patchResponse.status} ${patchText}`);
  }
  writeFileSync(webhookConfigPath, patchText, { encoding: "utf8", mode: 0o600 });

  console.log("Bridge ready.");
  console.log(`Webhook URL: ${tunnelUrl}/github`);
  console.log(`Relay log: ${relayLogPath}`);
  console.log(`Tunnel log: ${cloudflaredLogPath}`);
  console.log("Press Ctrl+C to stop.");

  const shutdown = async () => {
    cloudflared.kill("SIGTERM");
    relayServer.close();
    relayLog.end();
    cloudflaredLog.end();
  };

  let stopped = false;
  const onStop = async () => {
    if (stopped) return;
    stopped = true;
    await shutdown();
    process.exit(0);
  };

  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  cloudflared.on("exit", async () => {
    if (!stopped) {
      await shutdown();
      process.exit(0);
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
