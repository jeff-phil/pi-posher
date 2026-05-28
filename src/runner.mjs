import { spawn } from 'node:child_process';

import { isExecutableAvailable } from './lib/paths.mjs';

/**
 * Run a command via spawn and return a Promise resolving when the process closes.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number, signal?: AbortSignal, env?: Record<string,string> }} options
 */
export function execDirect(command, args, options) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timeoutId;
    let sigkillTimeoutId;
    const killProcess = () => {
      if (!killed) {
        killed = true;
        proc.kill('SIGTERM');
        sigkillTimeoutId = setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }
    };
    if (options.signal) {
      if (options.signal.aborted) killProcess();
      else options.signal.addEventListener('abort', killProcess, { once: true });
    }
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(killProcess, options.timeout);
    }
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (sigkillTimeoutId) clearTimeout(sigkillTimeoutId);
      if (options.signal) options.signal.removeEventListener('abort', killProcess);
      resolve({ stdout, stderr, code: 1, killed, error: 'spawn_failed' });
    });
    proc.on('close', (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (sigkillTimeoutId) clearTimeout(sigkillTimeoutId);
      if (options.signal) options.signal.removeEventListener('abort', killProcess);
      resolve({ stdout, stderr, code: code ?? (signal ? 1 : 0), killed });
    });
  });
}

/**
 * Run a resolved command with timing metadata.
 * @param {{ id: string, cmd: string, args: string[], cwd: string, env?: Record<string,string>, timeoutMs?: number }} command
 * @param {AbortSignal} [signal]
 */
export async function runCommand(command, signal) {
  const startedAt = Date.now();
  const result = await execDirect(command.cmd, command.args, {
    cwd: command.cwd,
    timeout: command.timeoutMs,
    signal,
    env: command.env ? { ...process.env, ...command.env } : undefined,
  });
  return {
    id: command.id,
    cmd: command.cmd,
    args: command.args,
    cwd: command.cwd,
    ...result,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Execute a resolved command, validating executability first.
 * Returns a structured result; if the command is not available,
 * `error` is set to `'not_found'` without spawning.
 * @param {{ id: string, cmd: string, args: string[], cwd: string, env?: Record<string,string>, timeoutMs?: number }} command
 * @param {AbortSignal} [signal]
 * @returns {Promise<{id, cmd, args, cwd, code, stdout, stderr, durationMs, killed, error: null | 'not_found' | 'spawn_failed'}>}
 */
export async function execute(command, signal) {
  if (!isExecutableAvailable(command.cmd)) {
    return {
      id: command.id,
      cmd: command.cmd,
      args: command.args,
      cwd: command.cwd,
      code: 1,
      stdout: '',
      stderr: '',
      durationMs: 0,
      killed: false,
      error: 'not_found',
    };
  }
  const result = await runCommand(command, signal);
  return { ...result, error: null };
}
