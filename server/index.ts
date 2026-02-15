import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, request as httpRequest } from 'http';
import { createPtyHandler, EchoPtyHandler, killTmuxSession, listTmuxSessions, ensureDefaultSession } from './pty-handler';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawn } from 'child_process';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const DIST_PATH = join(__dirname, '..', 'dist');
const ECHO_MODE = process.env.TERMINAL_MODE === 'echo';
const SANDBOX_ID = process.env.SANDBOX_ID;
const WORKER_API_URL = process.env.WORKER_API_URL || 'https://sandbox-launcher.terui.workers.dev';

// Self-update: check GCS for new app version on WebSocket connections
const LOCAL_VERSION_FILE = '/opt/sandboxterminal/.version';
const PULL_SCRIPT = '/opt/moltshell/pull-app.sh';
let lastUpdateCheck = 0;
const UPDATE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 min

async function checkForUpdates() {
  if (Date.now() - lastUpdateCheck < UPDATE_CHECK_INTERVAL) return;
  lastUpdateCheck = Date.now();
  try {
    const localVersion = existsSync(LOCAL_VERSION_FILE)
      ? readFileSync(LOCAL_VERSION_FILE, 'utf-8').trim() : '';
    const res = await fetch('https://storage.googleapis.com/moltshell-releases/latest-version.txt');
    if (!res.ok) return;
    const remote = (await res.text()).trim();
    if (remote && remote !== localVersion) {
      console.log(`[update] New version available: ${remote} (local: ${localVersion || 'none'})`);
      if (existsSync(PULL_SCRIPT)) {
        // Use async spawn to avoid blocking the event loop during download
        const child = spawn(PULL_SCRIPT, [], { stdio: 'inherit' });
        child.on('close', (code) => {
          if (code === 0) {
            console.log('[update] Pull complete, restarting...');
            process.exit(0); // systemd Restart=always brings us back
          } else {
            console.error(`[update] Pull script exited with code ${code}`);
          }
        });
        child.on('error', (err) => {
          console.error('[update] Pull script error:', err.message);
        });
      }
    }
  } catch (e) {
    console.error('[update] Check failed:', e instanceof Error ? e.message : e);
  }
}

// Heartbeat tracking - debounced to max once per 60 seconds
let lastHeartbeat = 0;
const HEARTBEAT_INTERVAL = 60 * 1000;

async function reportActivity() {
  if (!SANDBOX_ID) return;

  const now = Date.now();
  if (now - lastHeartbeat < HEARTBEAT_INTERVAL) return;
  lastHeartbeat = now;

  try {
    await fetch(`${WORKER_API_URL}/api/sandbox/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandboxId: SANDBOX_ID }),
    });
  } catch (err) {
    console.error('Heartbeat failed:', err);
  }
}

const app = express();
app.use(express.json());

// CORS for layout/sessions API — frontend is served from a different origin
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin === 'https://moltshell.sh' || origin === 'https://sandbox-launcher.terui.workers.dev') {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade manually to parse session query param
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '', `http://${request.headers.host}`);
  if (url.pathname !== '/ws/terminal') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    // Attach sessionId from query params
    const sessionId = url.searchParams.get('session') || 'default';
    (ws as any)._sessionId = sessionId;
    wss.emit('connection', ws, request);
  });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mode: ECHO_MODE ? 'echo' : 'pty', sandboxId: SANDBOX_ID || 'not-configured' });
});

// Layout persistence
const LAYOUT_DIR = process.env.HOME
  ? `${process.env.HOME}/.moltshell`
  : '/home/moltshell/.moltshell';
const LAYOUT_FILE = `${LAYOUT_DIR}/layout.json`;

app.get('/api/layout', (_req, res) => {
  try {
    if (!existsSync(LAYOUT_FILE)) {
      return res.status(404).json({ error: 'No saved layout' });
    }
    const data = readFileSync(LAYOUT_FILE, 'utf-8');
    res.json(JSON.parse(data));
  } catch (err) {
    console.error('Failed to read layout:', err);
    res.status(500).json({ error: 'Failed to read layout' });
  }
});

app.post('/api/layout', (req, res) => {
  try {
    mkdirSync(LAYOUT_DIR, { recursive: true });
    writeFileSync(LAYOUT_FILE, JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to save layout:', err);
    res.status(500).json({ error: 'Failed to save layout' });
  }
});

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: listTmuxSessions() });
});

// Restart all tmux sessions (kills existing, re-creates default with mouse mode)
app.post('/api/sessions/restart', (_req, res) => {
  try {
    // Kill all sandbox-* tmux sessions
    const sessions = listTmuxSessions();
    for (const sessionId of sessions) {
      killTmuxSession(sessionId);
    }
    console.log(`[restart] Killed ${sessions.length} tmux session(s)`);

    // Re-create default session with robust mouse mode
    ensureDefaultSession();
    console.log('[restart] Re-created default session');

    res.json({ success: true });
  } catch (err) {
    console.error('[restart] Failed:', err);
    res.status(500).json({ error: 'Failed to restart sessions' });
  }
});

// Preview proxy: forward /preview/:port/* to localhost:{port}
// Keeps GCP firewall locked to port 3001 only
app.use('/preview/:port', (req, res) => {
  const targetPort = parseInt(req.params.port, 10);
  if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    return res.status(400).json({ error: 'Invalid port' });
  }
  // Block privileged ports and the terminal server port to prevent SSRF
  if (targetPort < 1024 || targetPort === 3001) {
    return res.status(403).json({ error: 'Port not allowed' });
  }

  const targetPath = req.url || '/';
  const proxyReq = httpRequest(
    {
      hostname: 'localhost',
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${targetPort}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error(`Preview proxy error for port ${targetPort}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Cannot connect to port ${targetPort}` });
    }
  });

  req.pipe(proxyReq);
});

// Static file serving for production (serves built frontend from dist/)
if (existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));

  // SPA fallback - serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    // Skip API/WebSocket routes
    if (req.path.startsWith('/ws/') || req.path.startsWith('/health') || req.path.startsWith('/api/')) {
      return next();
    }
    res.sendFile(join(DIST_PATH, 'index.html'));
  });

  console.log(`Serving static files from: ${DIST_PATH}`);
} else {
  console.log('No dist/ folder found - run "npm run build" first for production');
}

wss.on('connection', (ws: WebSocket) => {
  const sessionId = (ws as any)._sessionId || 'default';
  console.log(`Client connected (session: ${sessionId})`);

  // Check for app updates (non-blocking)
  checkForUpdates().catch(() => {});

  const pty = ECHO_MODE ? new EchoPtyHandler() : createPtyHandler(sessionId);

  if (!pty) {
    ws.send(JSON.stringify({ type: 'error', message: 'Failed to create PTY' }));
    ws.close();
    return;
  }

  // Periodic heartbeat while connection is open (keeps sandbox alive during long-running
  // commands like Claude Code where user isn't typing but is watching output)
  const heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      reportActivity();
    }
  }, HEARTBEAT_INTERVAL);

  // Send shell output to client
  pty.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  });

  pty.onExit(() => {
    console.log('PTY exited');
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  // Handle client messages
  ws.on('message', (message: Buffer) => {
    try {
      const msg = JSON.parse(message.toString());

      switch (msg.type) {
        case 'input':
          pty.write(msg.data);
          break;
        case 'resize':
          if (msg.cols && msg.rows) {
            pty.resize(msg.cols, msg.rows);
          }
          break;
        case 'close-session':
          // Kill the tmux session permanently (used when closing a split pane)
          pty.kill();
          killTmuxSession(sessionId);
          ws.close();
          return;
      }

      // Report activity on any message
      reportActivity();
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    clearInterval(heartbeatTimer);
    pty.kill();
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clearInterval(heartbeatTimer);
    pty.kill();
  });
});

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Terminal server running on 0.0.0.0:${PORT}`);
  console.log(`Mode: ${ECHO_MODE ? 'echo' : 'pty'}`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws/terminal`);
  ensureDefaultSession();
});
