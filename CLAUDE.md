# MoltShell Terminal Server - AI Assistant Guide

**Last Updated**: 2026-02-19
**Purpose**: Express + WebSocket terminal server running on user GCP VMs
**Sibling Repo**: [MoltShell/app](https://github.com/MoltShell/app) — React frontend + Cloudflare Worker API

---

## Project Overview

This repo contains the **terminal server** for MoltShell — an Express + WebSocket server that provides persistent terminal sessions via `node-pty` and `tmux`. It runs on per-user GCP Compute Engine VMs and is managed by the Cloudflare Worker API in the sibling `app` repo.

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

## Development Workflow (MANDATORY)

### For terminal-server changes

This repo deploys directly on push to `main` (VMs pull from GitHub). There's no staging pipeline here — the staging environment in the **app repo** tests the full stack including this server.

```bash
# 1. Make changes, typecheck locally
npx tsc --noEmit

# 2. Test locally with the frontend
npm run dev                      # port 3001
cd ../app && npm run dev         # port 5173 — open http://localhost:5173/dev

# 3. Commit and push to main (this repo deploys directly)
git add <files>
git commit -m "Description"
git push origin main
```

**For changes that affect both repos**: Make the terminal-server changes first (push to main so the staging VM picks them up), then make the app changes in a feature branch with a PR so the staging pipeline tests the full stack.

### Staging environment

The staging VM (`moltshell-staging`) runs this terminal server. The staging pipeline in `MoltShell/app` resumes the VM, runs Playwright tests against it, and suspends it when done. Changes pushed to `main` here will be picked up by the staging VM on its next boot (when the CI pipeline resumes it).

### Agent Protocol: Testing Before Delivery

Before telling the user "it's done":

1. **Run typecheck locally**: `npx tsc --noEmit`
2. **Test locally with the frontend** if possible (run both servers, open `/dev`)
3. **For significant changes**: Push to main, then make a trivial PR in the app repo to trigger the staging pipeline and verify the terminal works end-to-end
4. **Never claim "it works" without evidence** — run the typecheck, test the change, verify the output

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

Routes requests from `/preview/{port}/path` to `localhost:{port}/path` on the VM.

**Security**: Blocks privileged ports (<1024) and the terminal server port (3001) to prevent SSRF.

## GCP VM Details

**GCP Project**: `termos-70709`
**Zone**: `us-central1-a`
**Machine type**: `e2-medium` (2 vCPU, 4GB RAM)
**Disk**: 15GB standard persistent disk (Ubuntu 22.04)

**Key advantage**: GCP `suspend` saves full RAM to disk. On `resume`, all processes (including tmux sessions) restore exactly. Zero compute billing while suspended (~$0.42/mo disk only).

**VM Startup Flow**:
First boot:
1. Startup script installs Node.js 22, tmux, nginx, tsx, build-essential
2. Creates `moltshell` user, app dirs, systemd service (with `After=google-startup-scripts.service`)
3. Writes SANDBOX_ID from GCE metadata
4. Creates `/opt/moltshell/pull-app.sh` (GitHub download script)
5. Runs `pull-app.sh` to download code from GitHub + npm install, restarts terminal service
6. Writes first-boot marker at `/opt/moltshell/.first-boot-done`

Subsequent boots (after reset/reboot):
1. Skips package installs (first-boot marker exists)
2. Writes SANDBOX_ID, updates pull-app.sh
3. Runs `pull-app.sh` (skips if already up to date) + `systemctl restart moltshell-terminal`

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

## Lessons / Past Mistakes

- **tmux mouse mode required for browser touch scrolling**: The frontend converts touch swipes to `WheelEvent`s, which xterm.js converts to mouse escape sequences. Without `tmux set -g mouse on`, tmux ignores these entirely. Set globally in `ensureDefaultSession()`.
- **npm install fails without build-essential**: `node-pty` requires `make`, `g++`, `python3`. Fix: install `build-essential python3` in VM startup script.
- **GCP disk persists across instance deletion (`autoDelete: false`)**: Orphaned disk has stale data. `pull-app.sh` found matching `.version` but `node_modules/` was missing. Fix: also check for `node_modules/` in version check.
- **Nginx config double-escaping in startup script**: `\\$http_upgrade` in JS template literal becomes `\$http_upgrade` in shell, stays literal in nginx config. Fix: use `$http_upgrade` directly — JS only interpolates `${...}` (with brace).
- **Cloudflare Workers' fetch() ignores non-standard ports**: Requests to `:3001` silently route to port 80. Fix: nginx on port 80 proxies to localhost:3001.
- **`tmux set -g mouse on` doesn't retrofit existing sessions**: The `-g` (global) flag only sets the default for **new** sessions. Sessions that already exist when the command runs won't inherit mouse mode. Fix: after the global set, also run `tmux set-option -t <session> mouse on` on every existing `sandbox-*` session.
- **`tmux set -g mouse on` can fail silently after new-session**: The tmux server may not be fully initialized yet. Fix: add `sleep 0.1` after `tmux new-session -d`, and retry the global set up to 3 times with 200ms between attempts.
- **GCP startup scripts are baked into instance metadata at creation time**: Updating the startup script in provisioner code does NOT update existing VMs. Old VMs keep running the old script (e.g., `User=daytona` instead of `User=moltshell`). Fix: use GCP `setMetadata` API to push the latest startup script to the instance before rebooting. The restart button now calls `updateStartupScript()` + `reset()`.
- **`${VAR:-default}` bash syntax inside JS template literals**: Template literals interpret `${...}` as JS expressions. Use `$VAR` (no braces) for shell variables in startup script template literals. Bash default values like `${VAR:-fallback}` must be avoided.
- **Existing VMs keep the old pull-app.sh after code changes**: The startup script (which writes `pull-app.sh`) is baked into VM metadata at creation time. Existing VMs won't get the new GitHub-based `pull-app.sh` until they receive an updated startup script via `handleRestartSession` (which calls `updateStartupScript()` + reboot). The self-update in `index.ts` (which runs on WS connections) will work with GitHub for the server code, but `pull-app.sh` itself won't be updated until the VM reboots with fresh metadata.
- **tmux `copy-pipe-and-cancel` breaks desktop text selection**: Mouse mode's default `MouseDragEnd1Pane` binding uses `copy-pipe-and-cancel`, which exits copy-mode on mouseup — making selections disappear instantly. Fix: override with `copy-pipe-no-clear` to keep selection visible.
- **systemd service race on VM reboot**: Without `After=google-startup-scripts.service`, the terminal service auto-starts with old code before the startup script downloads new code. Fix: add dependency + use `systemctl restart` (not `start`) at end of startup script + first-boot marker to skip slow installs on reboots.
- **`cp -r source/ dest/` nests when dest exists**: `cp -r dir/ existing_dir/` copies `dir` **inside** `existing_dir` as `existing_dir/dir/`, instead of overwriting contents. In `pull-app.sh`, `cp -r .../server/ $APP_DIR/server/` created `server/server/` with the new code while the old code remained in `server/`. Fix: `rm -rf "$APP_DIR/server"` before `cp -r`, and omit trailing slashes.
- **Sandbox state values are app-defined, not GCP values**: The D1 `state` column uses app states: `stopped`, `starting`, `started`, `stopping`, `error`. Never write raw GCP states like `running` or `suspended` — the frontend has no case for them and renders a broken card with no action buttons. `mapGcpState()` in `provisioner.ts` maps GCP statuses (RUNNING→`started`, SUSPENDED→`stopped`, etc.). When manually editing D1, always use the app state names.
- **tmux new-session inherits cwd from the tmux server, not from pty.spawn**: The `cwd` option in `pty.spawn('tmux', ...)` only sets the cwd for the tmux client process. The shell inside the tmux session starts in the tmux server's cwd (systemd WorkingDirectory = `/opt/sandboxterminal`). Fix: pass `-c $HOME` to `tmux new-session` so users land in their home directory.
- **User home directory must be clean**: `/home/moltshell` is the user's workspace. Never put infra/backend files there — app code lives in `/opt/sandboxterminal`, scripts in `/opt/moltshell`. The startup script cleans `~/snap` (Ubuntu clutter) and `~/.sudo_as_admin_successful` on every boot.
- **tmux 3.0+ right-click popup menu blocks browser context menu**: When mouse mode is enabled, tmux shows a built-in popup menu on right-click ("go to top", "go to bottom", "copy line", etc.) that prevents the browser's native context menu from appearing. Fix: `tmux unbind -n MouseDown3Pane` (and related status bindings) in `enableMouseModeAll()`, plus `rightClickSelectsWord: true` in xterm.js options on the frontend.
- **Startup script `pull-app.sh` runs as root, creating root-owned files**: The startup script runs as root, so `pull-app.sh` creates files owned by `root:root`. The self-update (running as `moltshell` user) can't overwrite `.version`, causing update failures and server crashes. Fix: `sudo -u moltshell /opt/moltshell/pull-app.sh` in the startup script.

---

**GitHub Repo**: https://github.com/MoltShell/terminal-server (PUBLIC)
