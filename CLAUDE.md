# MoltShell Terminal Server - AI Assistant Guide

**Last Updated**: 2026-02-13
**Purpose**: Express + WebSocket terminal server running on user VMs/sandboxes
**Sibling Repo**: [MoltShell/app](https://github.com/MoltShell/app) — React frontend + Cloudflare Worker API

---

## Project Overview

This repo contains the **terminal server** for MoltShell — an Express + WebSocket server that provides persistent terminal sessions via `node-pty` and `tmux`. It runs on per-user compute backends (GCP Compute Engine VMs or Daytona sandboxes) and is managed by the Cloudflare Worker API in the sibling `app` repo.

The server handles multiple independent terminal sessions (one per split pane), persists layout state to disk, and includes a preview proxy for accessing services running on the VM.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Server | Express 4 |
| WebSocket | ws library |
| PTY | node-pty + tmux for persistence |
| Runtime | Node.js 22 + tsx |
| Process Manager | systemd (on GCP VMs) |
| Deployment | GCS bucket (`gs://moltshell-releases/`) |

## Project Structure

```
terminal-server/
├── server/
│   ├── index.ts                  # Express + WebSocket + REST API
│   │                             #   - WebSocket at /ws/terminal?session=<id>
│   │                             #   - REST: GET/POST /api/layout, GET /api/sessions
│   │                             #   - Preview proxy at /preview/:port/*
│   │                             #   - Health endpoint at /health
│   │                             #   - Static file serving from dist/ (if present)
│   │                             #   - Self-update via GCS version check on WS connection
│   └── pty-handler.ts            # Multi-session tmux PTY management
│                                 #   - Creates/attaches tmux sessions named sandbox-{sessionId}
│                                 #   - ensureDefaultSession() for deterministic first pane
│                                 #   - Handles resize, input, close-session
│                                 #   - Cleanup on disconnect
├── scripts/
│   ├── deploy-to-gcs.sh         # Upload server tarball to gs://moltshell-releases/
│   └── build-gcp-image.sh       # GCP custom image builder (future)
├── deploy-to-daytona.mjs        # Deploy to Daytona sandbox (legacy)
├── package.json
├── tsconfig.json
└── .github/workflows/deploy.yml  # CI/CD: typecheck + deploy to GCS on push to main
```

## Quick Start

### Local Development
```bash
npm install
npm run dev          # tsx watch server/index.ts (port 3001)
```

### Local Development (with frontend)
```bash
# Terminal 1: start this server
npm run dev                              # port 3001

# Terminal 2: start frontend (from sibling repo)
cd ../app && npm run dev                 # port 5173

# Open http://localhost:5173/dev
```

The frontend's Vite proxy forwards `/ws/terminal` → `ws://localhost:3001`.

### Production
```bash
npm run start        # tsx server/index.ts
```

On GCP VMs, the server runs as a systemd service with `Restart=always`.

## Deployment

### GCS Release Pipeline (primary)
```bash
npm run deploy       # ./scripts/deploy-to-gcs.sh
```

This creates a tarball of `server/` + `package.json` + `package-lock.json`, computes a SHA256 version hash, and uploads both to `gs://moltshell-releases/`.

**CI/CD**: GitHub Actions deploys on push to `main`. PRs get typecheck only (no deploy).

**How VMs pick up updates**:
1. On first boot: startup script runs `pull-app.sh` to download from GCS
2. On WebSocket connection: server checks GCS version (5 min throttle), auto-restarts via systemd if stale

### Daytona (legacy)
```bash
node deploy-to-daytona.mjs
```

## WebSocket Protocol

Connection URL: `/ws/terminal?session=<sessionId>`

```typescript
// Client -> Server
{ type: 'input', data: string }
{ type: 'resize', cols: number, rows: number }
{ type: 'close-session' }  // Kill tmux session permanently (pane close)

// Server -> Client
{ type: 'output', data: string }
{ type: 'error', message: string }
```

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns `{ status: 'ok' }`) |
| `/api/layout` | GET | Get saved split layout from disk |
| `/api/layout` | POST | Save split layout to disk |
| `/api/sessions` | GET | List live tmux sessions |
| `/preview/:port/*` | ALL | Reverse proxy to `localhost:{port}` (blocks <1024 and 3001) |

## PTY / tmux Architecture

- Each terminal pane gets its own tmux session named `sandbox-{sessionId}`
- **First pane always uses `sandbox-default`** via `ensureDefaultSession()`
- Reconnecting to an existing session reattaches (processes survive disconnects)
- `close-session` message kills the tmux session permanently
- On GCP suspend/resume: tmux sessions survive because RAM is preserved to disk

### Layout Persistence

Split layout (tree structure + active pane ID) is saved to `~/.moltshell/layout.json` on the VM filesystem. The frontend fetches this on load and reconciles with live tmux sessions (dead sessions pruned, first leaf forced to `default`).

## Preview Proxy

Routes requests from `/preview/{port}/path` to `localhost:{port}/path` on the VM, adding `X-Daytona-Skip-Preview-Warning` header for Daytona compatibility.

**Security**: Blocks privileged ports (<1024) and the terminal server port (3001) to prevent SSRF.

## GCP VM Details

**GCP Project**: `termos-70709`
**Zone**: `us-central1-a`
**Machine type**: `e2-medium` (2 vCPU, 4GB RAM)
**Disk**: 30GB standard persistent disk (Ubuntu 22.04)

**Key advantage**: GCP `suspend` saves full RAM to disk. On `resume`, all processes (including tmux sessions) restore exactly. Zero compute billing while suspended (~$0.83/mo disk only).

**VM Startup Flow**:
1. Startup script installs Node.js 22, tmux, nginx, tsx, build-essential
2. Creates `moltshell` user, app dirs, systemd service
3. Writes SANDBOX_ID from GCE metadata
4. Creates `/opt/moltshell/pull-app.sh` (GCS download script)
5. Runs `pull-app.sh` to download code + npm install, starts terminal service

**Nginx**: Runs on port 80, proxies to localhost:3001. Required because Cloudflare Workers' `fetch()` only connects to standard ports.

**IAM Setup**:
```bash
# Service account: moltshell-vm-manager@termos-70709.iam.gserviceaccount.com
# Roles: roles/compute.admin, roles/iam.serviceAccountUser
# Firewall: TCP 3001 from Cloudflare IPs only, tag: terminal-server
# GCS bucket: moltshell-releases (us-central1)
# Default compute SA: roles/storage.objectViewer on bucket
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `TERMINAL_MODE` | — | Set to `echo` for testing (no real PTY) |
| `SANDBOX_ID` | — | Sandbox/VM ID (set by startup script, used for preview proxy) |

## Self-Update Mechanism

On each WebSocket connection, the server:
1. Checks `gs://moltshell-releases/latest-version.txt` (throttled to every 5 min)
2. Compares with local `.version` file
3. If different: downloads new tarball, extracts, runs `npm install`, exits
4. systemd `Restart=always` restarts the service with updated code

## Troubleshooting

### node-pty build errors
```bash
npm rebuild node-pty
# Requires: build-essential python3 (apt install)
```

### Server not starting on VM
- Check systemd: `systemctl status moltshell-terminal`
- Check logs: `journalctl -u moltshell-terminal -f`
- Verify node_modules: `ls /opt/moltshell/app/node_modules`

### Self-update not working
- Check GCS access: `gsutil cat gs://moltshell-releases/latest-version.txt`
- Check local version: `cat /opt/moltshell/app/.version`
- Manual update: `/opt/moltshell/pull-app.sh`

## Lessons / Past Mistakes

- **npm install fails without build-essential**: `node-pty` requires `make`, `g++`, `python3`. Fix: install `build-essential python3` in VM startup script.
- **GCP disk persists across instance deletion (`autoDelete: false`)**: Orphaned disk has stale data. `pull-app.sh` found matching `.version` but `node_modules/` was missing. Fix: also check for `node_modules/` in version check.
- **Nginx config double-escaping in startup script**: `\\$http_upgrade` in JS template literal becomes `\$http_upgrade` in shell, stays literal in nginx config. Fix: use `$http_upgrade` directly — JS only interpolates `${...}` (with brace).
- **Cloudflare Workers' fetch() ignores non-standard ports**: Requests to `:3001` silently route to port 80. Fix: nginx on port 80 proxies to localhost:3001.
- **Daytona Node v24.3.0 breaks `npx tsx`**: Fix: use `tsx` directly (global binary) wrapped in `bash -c`. The toolbox API does NOT invoke a shell by default.

---

**GitHub Repo**: https://github.com/MoltShell/terminal-server
**GCS Bucket**: gs://moltshell-releases/
