import * as pty from 'node-pty';
import * as os from 'os';
import { execSync } from 'child_process';

interface PtyHandler {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: () => void): void;
}

/**
 * Check if tmux is available
 */
function hasTmux(): boolean {
  try {
    execSync('which tmux', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if tmux session exists
 */
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux session permanently (for closing split panes).
 */
export function killTmuxSession(sessionId: string): void {
  const sessionName = `sandbox-${sessionId}`;
  try {
    execSync(`tmux kill-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' });
    console.log(`Killed tmux session: ${sessionName}`);
  } catch {
    // Session may not exist
  }
}

/**
 * Creates a PTY that attaches to a persistent tmux session.
 * The tmux session survives WebSocket disconnections.
 * @param sessionId - Unique session identifier (defaults to 'default')
 */
export function createPtyHandler(sessionId: string = 'default'): PtyHandler | null {
  const useTmux = hasTmux();
  const tmuxSessionName = `sandbox-${sessionId}`;

  let shell: string;
  let args: string[];

  if (useTmux) {
    shell = 'tmux';
    if (tmuxSessionExists(tmuxSessionName)) {
      // Attach to existing session
      args = ['attach-session', '-t', tmuxSessionName];
      console.log(`Attaching to existing tmux session: ${tmuxSessionName}`);
    } else {
      // Create new session
      args = ['new-session', '-s', tmuxSessionName];
      console.log(`Creating new tmux session: ${tmuxSessionName}`);
    }
  } else {
    // Fallback to regular shell if tmux not available
    shell = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
    args = [];
    console.log('tmux not available, using regular shell');
  }

  try {
    // Strip Claude Code env vars so spawned shells don't think they're nested
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE'))
    );

    const ptyProcess = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || process.cwd(),
      env: {
        ...cleanEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    let dataCallback: ((data: string) => void) | null = null;
    let exitCallback: (() => void) | null = null;

    ptyProcess.onData((data) => {
      if (dataCallback) {
        dataCallback(data);
      }
    });

    ptyProcess.onExit(() => {
      if (exitCallback) {
        exitCallback();
      }
    });

    return {
      write(data: string) {
        ptyProcess.write(data);
      },
      resize(cols: number, rows: number) {
        try {
          ptyProcess.resize(cols, rows);
        } catch (error) {
          console.error('Resize error:', error);
        }
      },
      kill() {
        try {
          ptyProcess.kill();
        } catch {
          // Already exited
        }
      },
      onData(callback: (data: string) => void) {
        dataCallback = callback;
      },
      onExit(callback: () => void) {
        exitCallback = callback;
      },
    };
  } catch (error) {
    console.error('Failed to spawn PTY:', error);
    return null;
  }
}

/**
 * Ensure the default tmux session exists on server startup.
 * Called once so the client can always attach to `sandbox-default`.
 */
export function ensureDefaultSession(): void {
  if (!hasTmux()) return;
  const sessionName = 'sandbox-default';
  if (!tmuxSessionExists(sessionName)) {
    execSync(`tmux new-session -d -s ${sessionName}`, { stdio: 'ignore' });
    console.log(`Created default tmux session: ${sessionName}`);
  }
  // Enable mouse mode globally so touch swipes in the browser
  // generate scroll events that tmux can handle
  try {
    execSync(`tmux set -g mouse on`, { stdio: 'ignore' });
  } catch {
    // tmux server may not be running yet
  }
}

/**
 * List all active tmux sessions with the `sandbox-` prefix,
 * returning just the UUID portion (i.e. the session IDs).
 */
export function listTmuxSessions(): string[] {
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}'", {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('sandbox-'))
      .map((s) => s.replace('sandbox-', ''));
  } catch {
    // tmux not running or no sessions
    return [];
  }
}

/**
 * Echo handler for testing without node-pty
 * Simply echoes back input and responds to basic commands
 */
export class EchoPtyHandler implements PtyHandler {
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: (() => void) | null = null;
  private buffer = '';

  constructor() {
    // Send initial prompt
    setTimeout(() => {
      this.emit('\r\n\x1b[32mecho-terminal\x1b[0m $ ');
    }, 100);
  }

  write(data: string) {
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        this.handleCommand();
      } else if (char === '\x7f' || char === '\b') {
        // Backspace
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.emit('\b \b');
        }
      } else if (char === '\x03') {
        // Ctrl+C
        this.buffer = '';
        this.emit('^C\r\n\x1b[32mecho-terminal\x1b[0m $ ');
      } else if (char === '\x04') {
        // Ctrl+D
        this.emit('\r\nexit\r\n');
        if (this.exitCallback) {
          this.exitCallback();
        }
      } else if (char === '\x0c') {
        // Ctrl+L - clear screen
        this.emit('\x1b[2J\x1b[H\x1b[32mecho-terminal\x1b[0m $ ' + this.buffer);
      } else if (char >= ' ') {
        this.buffer += char;
        this.emit(char);
      }
    }
  }

  private handleCommand() {
    const cmd = this.buffer.trim();
    this.buffer = '';
    this.emit('\r\n');

    if (cmd === 'help') {
      this.emit('Available commands: help, echo, clear, date, whoami, exit\r\n');
    } else if (cmd.startsWith('echo ')) {
      this.emit(cmd.slice(5) + '\r\n');
    } else if (cmd === 'clear') {
      this.emit('\x1b[2J\x1b[H');
    } else if (cmd === 'date') {
      this.emit(new Date().toString() + '\r\n');
    } else if (cmd === 'whoami') {
      this.emit('echo-user\r\n');
    } else if (cmd === 'exit') {
      this.emit('Goodbye!\r\n');
      if (this.exitCallback) {
        this.exitCallback();
      }
      return;
    } else if (cmd) {
      this.emit(`\x1b[33mecho-terminal:\x1b[0m command not found: ${cmd}\r\n`);
    }

    this.emit('\x1b[32mecho-terminal\x1b[0m $ ');
  }

  resize(_cols: number, _rows: number) {
    // Echo mode doesn't need resize handling
  }

  kill() {
    if (this.exitCallback) {
      this.exitCallback();
    }
  }

  onData(callback: (data: string) => void) {
    this.dataCallback = callback;
  }

  onExit(callback: () => void) {
    this.exitCallback = callback;
  }

  private emit(data: string) {
    if (this.dataCallback) {
      this.dataCallback(data);
    }
  }
}
