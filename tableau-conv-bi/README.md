# Tableau Conversational BI

A chat web app that lets you talk to your Tableau instance in natural language. It uses the
**Claude API** with the **MCP connector** to reach your **Tableau MCP server** over HTTP — so
Claude calls your Tableau tools directly and answers with real data.

```
Browser (chat UI)
   │  POST /api/chat  ── streamed back as Server-Sent Events
   ▼
Next.js API route (server-side)
   - holds ANTHROPIC_API_KEY (never sent to the browser)
   - tells Claude where the Tableau MCP server is
   ▼
Claude API  ── mcp_servers connector ──►  Your Tableau MCP HTTP endpoint (public DNS)
```

The backend implements **no MCP client of its own**. Claude's API connects to your MCP server
server-side; the web app just streams the conversation and keeps your API key secret.

---

## 1. Prerequisites

- Node.js 18.18+ (tested on Node 26)
- An Anthropic API key — <https://console.anthropic.com/settings/keys>
- Your Tableau MCP server already exposed at a public HTTPS URL (you have this)

## 2. Configure

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | Your Claude API key. |
| `ANTHROPIC_MODEL` | — | Defaults to `claude-opus-4-8`. Use `claude-sonnet-4-6` for lower cost. |
| `TABLEAU_MCP_URL` | ✅ | Public HTTPS URL of your MCP endpoint (e.g. `https://mcp.example.com/mcp`). |
| `TABLEAU_MCP_TOKEN` | — | Bearer token, **only if** your endpoint requires auth. Leave blank if open. |
| `TABLEAU_MCP_NAME` | — | Internal name Claude uses for the server. Defaults to `tableau`. |

> **Which URL?** The MCP connector needs a **streamable-HTTP** (or SSE) MCP endpoint that is
> reachable from the public internet (Anthropic's servers connect to it). That's usually the path
> ending in `/mcp` or `/sse`, not the base host. If you're unsure of auth, run the test below — it
> tells you whether a token is needed.

## 3. Test the MCP connection first

Before launching the UI, confirm Claude can actually reach your Tableau tools:

```bash
npm install
npm run test:mcp
```

This prints which Tableau tools were discovered, calls one read-only tool, and reports success or
the exact error (e.g. an auth failure → set `TABLEAU_MCP_TOKEN`; an unreachable URL → fix
`TABLEAU_MCP_URL` or your firewall).

## 4. Run locally

```bash
npm run dev
# open http://localhost:3001
```

Ask things like *"List my published data sources"* or *"What was revenue by region last quarter?"*.

### Preview the UI with no setup (mock mode)

To see and click through the whole UI — streaming text, Tableau tool chips, a Markdown
results table — **before** you have an API key or MCP URL, run in **mock mode**. When the
required env vars are absent, the chat returns a clearly-labelled simulated answer.

- In `npm run dev`, mock mode is **on automatically** when the env vars aren't set.
- If `next dev` won't start (see the OneDrive note below), use the production build with the
  `MOCK_CHAT=1` flag:

  **PowerShell (Windows):**
  ```powershell
  npm run build
  $env:MOCK_CHAT=1; npm run start
  # open http://localhost:3001
  ```

  **bash:**
  ```bash
  npm run build && MOCK_CHAT=1 npm run start
  ```

Mock mode never activates in a normal production deploy (no `MOCK_CHAT`), so simulated
numbers can't silently appear in the real app — without credentials you'd get a clear config
error instead.

> **OneDrive note:** this project sits in a OneDrive-synced folder. `next dev` (Next.js 15)
> crashes there with `EINVAL ... readlink ...\.next\diagnostics\framework.json` because
> OneDrive emulates symlinks. `npm run build` + `npm run start` work fine in OneDrive. For a
> smooth hot-reload dev experience, move the project to a non-synced path (e.g.
> `C:\dev\tableau-conv-bi`) — then `npm run dev` works normally.

---

## 5. Deploy on your GCP VM (behind your existing public DNS)

The app already builds in **standalone** mode (`output: "standalone"`), so it ships as a
self-contained Node server.

### 5a. Build

On the VM (or build locally and copy the repo up):

```bash
npm ci
npm run build
```

The standalone server lands in `.next/standalone/`. Next.js does **not** copy `static/` or
`public/` into it, so wire those up once:

```bash
# from the project root on the VM
cp -r .next/static .next/standalone/.next/static
# (only if you add a public/ folder later)
# cp -r public .next/standalone/public
```

### 5b. Run it as a service

Create `.env.local` (or export the same vars) next to where you run the server. Then run with a
process manager so it restarts on reboot/crash. Two options:

**Option A — systemd (recommended):** create `/etc/systemd/system/tableau-bi.service`:

```ini
[Unit]
Description=Tableau Conversational BI
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tableau-conv-bi
# Load secrets from a file (chmod 600). Or use individual Environment= lines.
EnvironmentFile=/opt/tableau-conv-bi/.env.local
Environment=PORT=3001
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node .next/standalone/server.js
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tableau-bi
sudo systemctl status tableau-bi
```

Binding to `127.0.0.1` keeps the Node server private; Nginx is the only thing exposed.

**Option B — pm2:**

```bash
npm i -g pm2
PORT=3001 HOSTNAME=127.0.0.1 pm2 start .next/standalone/server.js --name tableau-bi
pm2 save && pm2 startup
```

### 5c. Front it with Nginx + HTTPS

Put the app on a subdomain of your existing DNS (e.g. `bi.your-domain.com`). Nginx config:

```nginx
server {
    listen 80;
    server_name bi.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        # Required so SSE streaming from /api/chat flows through immediately:
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> The `proxy_buffering off;` line matters — without it Nginx buffers the response and the chat
> appears to "hang" until the whole answer is ready instead of streaming token by token.

Then add a free TLS cert:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d bi.your-domain.com
```

Open the firewall for 80/443 only (GCP: a firewall rule on the VM's network tag). The Node port
3001 stays internal.

---

## 6. Security notes

- **The API key never reaches the browser** — it lives only in the server-side route. Keep
  `.env.local` at `chmod 600` and never commit it (it's gitignored).
- **There's no app-level auth.** If `bi.your-domain.com` is public, anyone who finds it can spend
  your Claude credits and query your Tableau data. Before exposing it, add one of: GCP IAP, Nginx
  Basic Auth (`auth_basic`), an OAuth proxy (e.g. oauth2-proxy), or a VPN/IP allowlist. Easiest
  quick lock-down:

  ```bash
  sudo apt install apache2-utils
  sudo htpasswd -c /etc/nginx/.htpasswd youruser
  # then in the nginx location block:
  #   auth_basic "Restricted";
  #   auth_basic_user_file /etc/nginx/.htpasswd;
  ```

- **Treat answers as assistant-generated.** Verify figures against Tableau before sharing widely.

---

## How it works (code map)

| File | Role |
| --- | --- |
| `app/api/chat/route.ts` | Streaming endpoint. Calls Claude with the MCP connector, forwards text + tool activity as SSE, handles `pause_turn` continuations, returns final assistant blocks for multi-turn context. |
| `app/page.tsx` | Chat UI. Holds conversation history, parses the SSE stream, renders Markdown/tables, shows Tableau tool chips. |
| `lib/config.ts` | Reads/validates env vars; holds the system prompt. |
| `scripts/test-mcp.ts` | Standalone MCP connectivity check (`npm run test:mcp`). |

### Tuning

- **Model / cost:** set `ANTHROPIC_MODEL=claude-sonnet-4-6` in `.env.local`.
- **Longer answers:** raise `MAX_TOKENS` in `app/api/chat/route.ts`.
- **Behavior:** edit `SYSTEM_PROMPT` in `lib/config.ts`.
