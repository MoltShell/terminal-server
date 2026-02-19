# MoltShell Terminal Server - AI Assistant Guide

**Last Updated**: 2026-02-15
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
| Deployment | GitHub public repo (VMs pull from GitHub) |

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
│   │                             #   - Self-update via GitHub API version check on WS connection
│   └── pty-handler.ts            # Multi-session tmux PTY management
│                                 #   - Creates/attaches tmux sessions named sandbox-{sessionId}
│                                 #   - ensureDefaultSession() for deterministic first pane
│                                 #   - Handles resize, input, close-session
│                                 #   - Cleanup on disconnect
├── scripts/
│   ├── deploy-to-gcs.sh         # (LEGACY — no longer used) Upload to GCS
│   └── build-gcp-image.sh       # GCP custom image builder (future)
├── package.json
├── tsconfig.json
└── .github/workflows/deploy.yml  # CI/CD: typecheck on push to main (VMs pull directly from GitHub)
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

**Push to `main` triggers deployment automatically** — no manual steps needed. Just commit and push.

The repo is **public** on GitHub. VMs pull code directly from GitHub — no GCS bucket or service account needed.

**CI/CD**: GitHub Actions runs typecheck on push to `main`. PRs get typecheck only.

**How VMs pick up updates**:
1. On first boot: startup script runs `pull-app.sh` which downloads from `https://github.com/MoltShell/terminal-server/archive/refs/heads/main.tar.gz`
2. On WebSocket connection: server checks GitHub API for latest commit SHA on `main` (5 min throttle), runs `pull-app.sh` + auto-restarts via systemd if stale
3. Version tracking: `/opt/sandboxterminal/.version` stores the current commit SHA

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
| `/api/sessions/restart` | POST | Kill all sandbox-* tmux sessions, re-create default with mouse mode |
| `/preview/:port/*` | ALL | Reverse proxy to `localhost:{port}` (blocks <1024 and 3001) |

## PTY / tmux Architecture

- Each terminal pane gets its own tmux session named `sandbox-{sessionId}`
- **First pane always uses `sandbox-default`** via `ensureDefaultSession()`
- **Mouse mode is set robustly** in `ensureDefaultSession()` — retries `tmux set -g mouse on` up to 3 times (200ms apart), then also applies `tmux set-option -t <session> mouse on` to all existing `sandbox-*` sessions (the `-g` flag only affects new sessions). Additionally, `createPtyHandler()` sets mouse mode per-session 200ms after creation. Required for browser touch scrolling in the alternate buffer (xterm.js converts touch swipes to mouse escape sequences that tmux processes for scroll-back)
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
4. Creates `/opt/moltshell/pull-app.sh` (GitHub download script)
5. Runs `pull-app.sh` to download code from GitHub + npm install, starts terminal service

**Nginx**: Runs on port 80, proxies to localhost:3001. Required because Cloudflare Workers' `fetch()` only connects to standard ports.

**IAM Setup**:
```bash
# Service account: moltshell-vm-manager@termos-70709.iam.gserviceaccount.com
# Roles: roles/compute.admin, roles/iam.serviceAccountUser
# Firewall: TCP 3001 from Cloudflare IPs only, tag: terminal-server
# VMs have NO service account attached — they pull code from the public GitHub repo
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `TERMINAL_MODE` | — | Set to `echo` for testing (no real PTY) |
| `SANDBOX_ID` | — | Sandbox/VM ID (set by startup script, used for preview proxy) |

## Self-Update Mechanism

On each WebSocket connection, the server:
1. Calls GitHub API (`GET /repos/MoltShell/terminal-server/commits/main` with `Accept: application/vnd.github.sha`) to get the latest commit SHA (throttled to every 5 min)
2. Compares with local `/opt/sandboxterminal/.version` file
3. If different: runs `/opt/moltshell/pull-app.sh` (downloads tarball from GitHub, extracts, npm install), then exits
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
- Check GitHub API access: `curl -sf -H "Accept: application/vnd.github.sha" https://api.github.com/repos/MoltShell/terminal-server/commits/main`
- Check local version: `cat /opt/sandboxterminal/.version`
- Manual update: `/opt/moltshell/pull-app.sh`
- Check if VM has the old GCS-based pull-app.sh: `cat /opt/moltshell/pull-app.sh` — if it references `storage.googleapis.com`, the VM needs a restart-session to get the updated startup script

## Lessons / Past Mistakes

- **tmux mouse mode required for browser touch scrolling**: The frontend converts touch swipes to `WheelEvent`s, which xterm.js converts to mouse escape sequences. Without `tmux set -g mouse on`, tmux ignores these entirely. Set globally in `ensureDefaultSession()`.
- **npm install fails without build-essential**: `node-pty` requires `make`, `g++`, `python3`. Fix: install `build-essential python3` in VM startup script.
- **GCP disk persists across instance deletion (`autoDelete: false`)**: Orphaned disk has stale data. `pull-app.sh` found matching `.version` but `node_modules/` was missing. Fix: also check for `node_modules/` in version check.
- **Nginx config double-escaping in startup script**: `\\$http_upgrade` in JS template literal becomes `\$http_upgrade` in shell, stays literal in nginx config. Fix: use `$http_upgrade` directly — JS only interpolates `${...}` (with brace).
- **Cloudflare Workers' fetch() ignores non-standard ports**: Requests to `:3001` silently route to port 80. Fix: nginx on port 80 proxies to localhost:3001.
- **Daytona Node v24.3.0 breaks `npx tsx`**: Fix: use `tsx` directly (global binary) wrapped in `bash -c`. The toolbox API does NOT invoke a shell by default.
- **`tmux set -g mouse on` doesn't retrofit existing sessions**: The `-g` (global) flag only sets the default for **new** sessions. Sessions that already exist when the command runs won't inherit mouse mode. Fix: after the global set, also run `tmux set-option -t <session> mouse on` on every existing `sandbox-*` session.
- **`tmux set -g mouse on` can fail silently after new-session**: The tmux server may not be fully initialized yet. Fix: add `sleep 0.1` after `tmux new-session -d`, and retry the global set up to 3 times with 200ms between attempts.
- **GCP startup scripts are baked into instance metadata at creation time**: Updating the startup script in provisioner code does NOT update existing VMs. Old VMs keep running the old script (e.g., `User=daytona` instead of `User=moltshell`). Fix: use GCP `setMetadata` API to push the latest startup script to the instance before rebooting. The restart button now calls `updateStartupScript()` + `reset()`.
- **Layout dir fallback was hardcoded to `/home/daytona`**: The terminal server's `LAYOUT_DIR` had a fallback to `/home/daytona/.moltshell`. Fix: changed to `/home/moltshell/.moltshell`.
- **GCS self-update never worked — VMs had no service account**: VMs were created without a service account (`serviceAccounts: null`), so `pull-app.sh` couldn't get a metadata token for GCS auth. Migrated to GitHub: repo is public, VMs download tarballs unauthenticated. Self-update checks GitHub API for latest commit SHA. Giving VMs a service account was rejected as too dangerous (overprivileged).
- **`${VAR:-default}` bash syntax inside JS template literals**: Template literals interpret `${...}` as JS expressions. Use `$VAR` (no braces) for shell variables in startup script template literals. Bash default values like `${VAR:-fallback}` must be avoided.
- **Existing VMs keep the old pull-app.sh after code changes**: The startup script (which writes `pull-app.sh`) is baked into VM metadata at creation time. Existing VMs won't get the new GitHub-based `pull-app.sh` until they receive an updated startup script via `handleRestartSession` (which calls `updateStartupScript()` + reboot). The self-update in `index.ts` (which runs on WS connections) will work with GitHub for the server code, but `pull-app.sh` itself won't be updated until the VM reboots with fresh metadata.
- **tmux `copy-pipe-and-cancel` breaks desktop text selection**: Mouse mode's default `MouseDragEnd1Pane` binding uses `copy-pipe-and-cancel`, which exits copy-mode on mouseup — making selections disappear instantly. Fix: override with `copy-pipe-no-clear` to keep selection visible.

---

**GitHub Repo**: https://github.com/MoltShell/terminal-server (PUBLIC)
