#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
ENV_FILE="$STATE_DIR/.env"
RELAY_PORT="${RELAY_PORT:-18990}"
RELAY_LOG="/tmp/github-openclaw-relay.log"
CF_LOG="/tmp/cloudflared-openclaw.log"
RELAY_JS="/tmp/github-openclaw-relay.mjs"

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required binary: $1" >&2
    exit 1
  fi
}

read_env() {
  local key="$1"
  awk -F= -v k="$key" '$1==k { print substr($0, index($0, "=")+1); exit }' "$ENV_FILE"
}

make_jwt() {
  APP_ID="$1" APP_KEY="$2" node - <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const appId = process.env.APP_ID;
const keyPath = process.env.APP_KEY;
const pem = fs.readFileSync(keyPath, 'utf8');
const now = Math.floor(Date.now() / 1000);
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const head = b64({ alg: 'RS256', typ: 'JWT' });
const body = b64({ iat: now - 60, exp: now + 9 * 60, iss: appId });
const unsigned = `${head}.${body}`;
const sig = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(pem).toString('base64url');
process.stdout.write(`${unsigned}.${sig}`);
NODE
}

require_bin node
require_bin curl
require_bin jq
require_bin rg
require_bin cloudflared

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  exit 1
fi

HOOK_TOKEN="$(read_env OPENCLAW_HOOKS_TOKEN)"
APP_ID="$(read_env GITHUB_APP_ID)"
APP_KEY_PATH="$(read_env GITHUB_APP_PRIVATE_KEY_PATH)"
WEBHOOK_SECRET="$(read_env GITHUB_APP_WEBHOOK_SECRET)"

if [ -z "$HOOK_TOKEN" ] || [ -z "$APP_ID" ] || [ -z "$APP_KEY_PATH" ] || [ -z "$WEBHOOK_SECRET" ]; then
  echo "Missing one of required env keys in $ENV_FILE:" >&2
  echo "OPENCLAW_HOOKS_TOKEN, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_WEBHOOK_SECRET" >&2
  exit 1
fi

if [ ! -f "$APP_KEY_PATH" ]; then
  echo "GitHub App private key file not found: $APP_KEY_PATH" >&2
  exit 1
fi

pkill -f "cloudflared tunnel --url http://127.0.0.1:${RELAY_PORT}" >/dev/null 2>&1 || true
pkill -f "$RELAY_JS" >/dev/null 2>&1 || true

cat >"$RELAY_JS" <<'EOF'
import http from 'node:http';
const port = Number(process.env.RELAY_PORT || 18990);
const target = process.env.OPENCLAW_HOOK_TARGET || 'http://127.0.0.1:18789/hooks/github';
const hookToken = process.env.OPENCLAW_HOOKS_TOKEN;
if (!hookToken) { console.error('Missing OPENCLAW_HOOKS_TOKEN'); process.exit(1); }
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', 'x-openclaw-token': hookToken };
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith('x-github-') || lower === 'x-hub-signature-256') headers[lower] = Array.isArray(v) ? v.join(',') : (v || '');
  }
  try {
    const upstream = await fetch(target, { method: 'POST', headers, body });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('content-type', upstream.headers.get('content-type') || 'text/plain; charset=utf-8');
    res.end(text);
  } catch (err) {
    res.statusCode = 502;
    res.end(`relay_error:${String(err)}`);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`relay_listening http://127.0.0.1:${port}`));
EOF

rm -f "$RELAY_LOG" "$CF_LOG"
env OPENCLAW_HOOKS_TOKEN="$HOOK_TOKEN" RELAY_PORT="$RELAY_PORT" node "$RELAY_JS" >"$RELAY_LOG" 2>&1 &
RELAY_PID=$!
cloudflared tunnel --url "http://127.0.0.1:${RELAY_PORT}" --no-autoupdate >"$CF_LOG" 2>&1 &
CF_PID=$!

cleanup() {
  kill "$CF_PID" >/dev/null 2>&1 || true
  kill "$RELAY_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 90); do
  TUNNEL_URL="$(rg -o 'https://[-a-z0-9]+\.trycloudflare\.com' "$CF_LOG" | head -n1 || true)"
  if [ -n "$TUNNEL_URL" ]; then break; fi
  sleep 1
done
if [ -z "${TUNNEL_URL:-}" ]; then
  echo "Failed to get cloudflared tunnel URL." >&2
  sed -n '1,120p' "$CF_LOG" >&2 || true
  exit 1
fi

APP_JWT="$(make_jwt "$APP_ID" "$APP_KEY_PATH")"
PATCH_PAYLOAD="$(jq -nc --arg url "${TUNNEL_URL}/github" --arg secret "$WEBHOOK_SECRET" '{url:$url,content_type:"json",secret:$secret}')"
curl -sS -X PATCH \
  -H "Authorization: Bearer $APP_JWT" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  https://api.github.com/app/hook/config \
  -d "$PATCH_PAYLOAD" >/tmp/clawengineer-webhook-config.json

echo "Bridge ready."
echo "Webhook URL: ${TUNNEL_URL}/github"
echo "Relay log: $RELAY_LOG"
echo "Tunnel log: $CF_LOG"
echo "Press Ctrl+C to stop."
tail -f "$RELAY_LOG" "$CF_LOG"
