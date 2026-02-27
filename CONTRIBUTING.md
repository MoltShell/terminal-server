# Contributing to MoltShell Terminal Server

Thanks for your interest in contributing! This document covers how to get started.

## Reporting Issues

- **Bug reports**: Open an issue with steps to reproduce, expected vs actual behavior, and your OS/Node.js version.
- **Feature requests**: Open an issue describing the use case and proposed solution.
- **Security vulnerabilities**: Email security@moltshell.sh instead of opening a public issue.

## Development Setup

```bash
# 1. Fork and clone
git clone https://github.com/<your-username>/terminal-server.git
cd terminal-server

# 2. Install dependencies
sudo apt install -y build-essential python3 tmux
npm install

# 3. Start the dev server
npm run dev    # Runs on port 3001 with auto-reload

# 4. (Optional) Run with the frontend
cd ../app && npm run dev    # Port 5173, open http://localhost:5173/dev
```

### Running without tmux

For development without tmux installed, set `TERMINAL_MODE=echo`:

```bash
TERMINAL_MODE=echo npm run dev
```

This starts the server with an echo handler — input is echoed back instead of going to a real PTY. Useful for testing the WebSocket layer.

## Pull Request Process

1. **Fork the repo** and create a feature branch from `main`.
2. **Make your changes** — keep PRs focused on a single issue.
3. **Run typecheck**: `npx tsc --noEmit`
4. **Test locally** with `npm run dev` (and the frontend if your change affects the terminal).
5. **Open a PR** against `main` with a clear description of what changed and why.

### What happens when you open a PR

- GitHub Actions runs a typecheck on your PR.
- A maintainer will review your code and may request changes.
- Once approved, a maintainer will merge your PR.

### Important: pushes to `main` go live immediately

This repo has no staging pipeline. When a PR is merged to `main`, all production VMs pick up the changes within 5 minutes (via the self-update mechanism). Maintainers are responsible for verifying changes before merging.

## Code Style

- TypeScript with strict mode enabled.
- ES modules (`import`/`export`).
- No specific formatter enforced yet — just be consistent with the existing code.

## Areas Where Contributions Are Welcome

- **Test coverage** — Unit/integration tests for the WebSocket handler, PTY management, and REST API.
- **Documentation** — Improving README, inline comments, or architecture docs.
- **Bug fixes** — Especially around edge cases in tmux session management or WebSocket lifecycle.
- **Cross-platform** — Making the server work on macOS for local development (currently Linux-focused).
- **Performance** — Memory usage optimization, connection handling improvements.

## What's Out of Scope

- **GCP-specific infra changes** — The VM provisioning and startup scripts are managed by the private `MoltShell/app` repo.
- **Frontend changes** — The terminal UI lives in `MoltShell/app` (private repo).
- **Authentication** — Auth is handled by the Cloudflare Worker proxy, not this server.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
