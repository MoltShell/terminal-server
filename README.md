# MoltShell Terminal Server

> Part of [MoltShell](https://moltshell.sh) -- a browser-based terminal with per-user Linux VMs. This server runs on each VM, providing WebSocket terminal access with persistent tmux sessions.
>
> [Docs](https://docs.moltshell.sh) | [App repo](https://github.com/MoltShell/app)

WebSocket terminal server with persistent tmux sessions, built for [MoltShell](https://moltshell.sh).

Runs on Linux VMs and provides browser-based terminal access via xterm.js. Sessions survive disconnects, VM suspend/resume, and browser restarts.

## Features

- **Persistent sessions** — tmux-backed. Close your browser, come back later, everything is still running.
- **Multiple panes** — Independent terminal sessions per split pane, each with its own tmux session.
- **Port forwarding** — Reverse proxy to preview web apps running on the VM (`/preview/:port/*`).
- **Self-updating** — Checks GitHub for new commits and auto-updates on WebSocket connections.
- **Memory monitoring** — Reads `/proc/meminfo`, broadcasts alerts to connected clients at 80%/90% thresholds.
- **Dead connection detection** — Application-level ping/pong (protocol-level pings are absorbed by reverse proxies like Cloudflare).

## Quick Start

```bash
# Install dependencies (requires build-essential for node-pty)
sudo apt install -y build-essential python3
npm install

# Start the server
npm run dev    # Development (auto-reload)
npm start      # Production
```

The server starts on port 3001 by default.

### With the MoltShell frontend

```bash
# Terminal 1: start this server
npm run dev                              # port 3001

# Terminal 2: start the frontend (from the app repo)
cd ../app && npm run dev                 # port 5173

# Open http://localhost:5173/dev
```

## Architecture

```
Browser (xterm.js)
  │
  ├── WebSocket /ws/terminal?session=<id>
  │     └── node-pty → tmux session (sandbox-<id>)
  │
  ├── REST API
  │     ├── GET  /health          — Health check + memory stats
  │     ├── GET  /api/layout      — Get saved split layout
  │     ├── POST /api/layout      — Save split layout
  │     ├── GET  /api/sessions    — List live tmux sessions
  │     └── POST /api/sessions/restart — Restart all sessions
  │
  └── Preview Proxy
        └── /preview/:port/*      — Reverse proxy to localhost:{port}
```

Each terminal pane gets its own tmux session named `sandbox-{sessionId}`. The first pane always uses `sandbox-default`.

### WebSocket Protocol

```typescript
// Client → Server
{ type: 'input', data: string }
{ type: 'resize', cols: number, rows: number }
{ type: 'close-session' }
{ type: 'pong' }              // Response to server ping

// Server → Client
{ type: 'output', data: string }
{ type: 'error', message: string }
{ type: 'ping' }              // App-level ping (every 30s)
{ type: 'system-alert', level: 'warning' | 'critical', message: string }
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `TERMINAL_MODE` | — | Set to `echo` for testing without a real PTY |
| `SANDBOX_ID` | — | VM identifier (used for heartbeat reporting) |
| `WORKER_API_URL` | `https://sandbox-launcher.terui.workers.dev` | API endpoint for heartbeat |

## Production Deployment (GCP VMs)

On MoltShell's GCP VMs, this server runs as a systemd service behind nginx (port 80 → localhost:3001). VMs auto-update by pulling from this GitHub repo on each WebSocket connection.

See `scripts/build-gcp-image.sh` for the full VM setup: Node.js 22, tmux, nginx, systemd service, and the self-update mechanism.

## Requirements

- Node.js 22+
- tmux (for persistent sessions)
- Linux (node-pty uses Unix PTYs)
- build-essential + python3 (to compile node-pty)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
