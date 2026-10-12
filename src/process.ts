import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export class ProcessError extends Error {
  constructor(public code: 'missing' | 'failed' | 'cancelled' | 'output_limit', message: string) {
    super(message);
  }
}

export function failureHint(diagnostic: string): string {
  if (/Filename too long|\$GIT_DIR.*too big/i.test(diagnostic)) return 'Temporary Git path exceeds the supported path length. Use a shorter output or publication state directory.';
  if (/git.bash|CLAUDE_CODE_GIT_BASH_PATH/i.test(diagnostic)) return 'Claude Code requires Git Bash on Windows. Set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe.';
  if (/model.{0,150}(not supported|not found|does not exist)/i.test(diagnostic)) return 'The model is unavailable for this account. Choose an accessible --model and check your Codex CLI version.';
  if (/401|unauthorized|authentication|login required|Invalid API key/i.test(diagnostic)) return 'Authentication failed. Check the failing tool’s login or API key and configured auth mode.';
  if (/429|rate.limit/i.test(diagnostic)) return 'Provider rate limit reached. Retry later or reduce review frequency.';
  if (/schema|invalid configuration|unrecognized configuration/i.test(diagnostic)) return 'Provider configuration or output schema was rejected. Check CLI compatibility.';
  return 'Check installation, authentication, model access, and connectivity.';
}

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  maxBytes?: number;
};

// Resolve npm's Windows shim without invoking a shell with user-controlled arguments.
export async function resolveCodex(): Promise<{ command: string; prefix: string[] }> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const executable = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { await access(executable); return { command: executable, prefix: [] }; } catch {}
    if (process.platform === 'win32') {
      for (const script of [join(dir, '..', '@openai', 'codex', 'bin', 'codex.js'), join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]) {
        try { await access(script); return { command: process.execPath, prefix: [script] }; } catch {}
      }
    }
  }
  throw new ProcessError('missing', 'Codex CLI not found. Install @openai/codex and ensure it is on PATH.');
}

export async function resolveNative(name: 'claude' | 'grok'): Promise<{ command: string; prefix: string[] }> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const executable = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    try { await access(executable); return { command: executable, prefix: [] }; } catch {}
    if (name === 'claude' && process.platform === 'win32') {
      for (const script of [join(dir, '..', '@anthropic-ai', 'claude-code', 'cli.js'), join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')]) {
        try { await access(script); return { command: process.execPath, prefix: [script] }; } catch {}
      }
    }
  }
  throw new ProcessError('missing', `${name} CLI not found. Install the official CLI and ensure it is on PATH.`);
}

export function baseEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => allowed.has(k.toLowerCase()) && k.toLowerCase() !== 'path'));
  env.PATH = process.env.PATH ?? dirname(process.execPath);
  env.NO_COLOR = '1';
  return env;
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  if (options.signal?.aborted) throw new ProcessError('cancelled', 'Operation cancelled or deadline exceeded.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env ?? process.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let failure: ProcessError | undefined;
    let length = 0;
    const chunks: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    const max = options.maxBytes ?? 8_000_000;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    };
    const cancel = () => {
      failure ??= new ProcessError('cancelled', 'Operation cancelled or deadline exceeded.');
      stop();
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const collect = (data: Buffer, stdout: boolean) => {
      length += data.length;
      if (length > max && !failure) {
        failure = new ProcessError('output_limit', 'Command output exceeded the configured limit.');
        stop();
      }
      if (stdout && !failure) chunks.push(data);
      if (!stdout && length < 64_000) diagnostics.push(data);
      // Never persist stderr: authentication failures can contain credentials or private configuration.
    };
    child.stdout.on('data', data => collect(data, true));
    child.stderr.on('data', data => collect(data, false));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
    child.on('error', error => {
      failure ??= new ProcessError('missing', `Unable to start ${command.split(/[\\/]/).at(-1)}: ${(error as NodeJS.ErrnoException).code ?? 'process error'}.`);
    });
    child.on('close', code => {
      options.signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(new ProcessError('failed', `${command.split(/[\\/]/).at(-1)} exited with code ${code}. ${failureHint(Buffer.concat([...diagnostics, ...chunks]).toString('utf8'))}`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
