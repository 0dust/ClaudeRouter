import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const HOOK_PATH = path.resolve(__dirname, '../../hooks/user-prompt-submit.js');

// Fake claude-router Node.js script — behaviour driven by FAKE_TIER env var
const FAKE_CLAUDE_ROUTER_JS = `
'use strict';
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  const tier = process.env.FAKE_TIER || 'MEDIUM';
  if (tier === 'ERROR') process.exit(1);
  if (tier === 'HANG') { setTimeout(() => {}, 300000); return; }
  if (process.argv[2] === '--version') { process.stdout.write('0.0.0-test\\n'); process.exit(0); }
  const directives = {
    LOW:    '[ROUTER] Complexity: LOW. Delegate this entire task to a Haiku subagent via the Agent tool and return its response verbatim. Do not add commentary.',
    MEDIUM: '[ROUTER] Complexity: MEDIUM. Delegate this entire task to a Sonnet subagent via the Agent tool and return its response verbatim. Do not add commentary.',
    HIGH:   '[ROUTER] Complexity: HIGH. Handle this task directly with full reasoning.',
  };
  const line = directives[tier] || directives.MEDIUM;
  process.stdout.write(line + '\\n');
  process.exit(0);
});
`;

let fakeBinDir: string;

function uid(): string {
  return crypto.randomUUID();
}

function guardFile(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.tmpdir(), `.claude-router-guard-${safeId}`);
}

function cleanupGuard(sessionId: string): void {
  try { fs.unlinkSync(guardFile(sessionId)); } catch { /* ignore */ }
}

beforeEach(() => {
  fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-hook-test-'));

  // Write the fake claude-router JS
  const jsPath = path.join(fakeBinDir, 'claude-router.js');
  fs.writeFileSync(jsPath, FAKE_CLAUDE_ROUTER_JS);

  if (process.platform === 'win32') {
    // On Windows, PATH lookup needs a .cmd wrapper
    fs.writeFileSync(
      path.join(fakeBinDir, 'claude-router.cmd'),
      `@echo off\nnode "%~dp0claude-router.js" %*\n`
    );
  } else {
    // On Unix, a shell wrapper with no extension
    fs.writeFileSync(
      path.join(fakeBinDir, 'claude-router'),
      `#!/bin/sh\nexec node "$(dirname "$0")/claude-router.js" "$@"\n`,
      { mode: 0o755 }
    );
  }
});

afterEach(() => {
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
});

async function runHook(
  input: object,
  options?: { env?: Record<string, string>; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options?.timeout ?? 10000;
  return new Promise((resolve) => {
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${fakeBinDir}${pathSep}${process.env.PATH ?? ''}`,
      FAKE_TIER: 'MEDIUM',
      ...options?.env,
    };

    const child = spawn(process.execPath, [HOOK_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

describe('hook e2e', () => {
  describe('hook input handling', () => {
    it('valid prompt, tier LOW → stdout contains "[ROUTER] Complexity: LOW"', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'classify me', session_id: sid },
        { env: { FAKE_TIER: 'LOW' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[ROUTER] Complexity: LOW');
    });

    it('valid prompt, tier MEDIUM → stdout contains "[ROUTER] Complexity: MEDIUM"', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'classify me', session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[ROUTER] Complexity: MEDIUM');
    });

    it('valid prompt, tier HIGH → stdout is empty (suppressed)', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'classify me', session_id: sid },
        { env: { FAKE_TIER: 'HIGH' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('is_subagent: true → stdout is empty, exits before calling classifier', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'classify me', is_subagent: true, session_id: sid },
        { env: { FAKE_TIER: 'LOW' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('missing prompt field → stdout is empty, exit code 0', async () => {
      const sid = uid();
      const result = await runHook({ session_id: sid });
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('prompt field is null → stdout is empty, exit code 0', async () => {
      const sid = uid();
      const result = await runHook({ prompt: null, session_id: sid });
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('prompt is only whitespace → stdout is empty, exit code 0', async () => {
      const sid = uid();
      const result = await runHook({ prompt: '   ', session_id: sid });
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });
  });

  describe('shell safety', () => {
    it('prompt with single quotes does not crash', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: "it's a test with 'quotes'", session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[ROUTER]');
    });

    it('prompt with double quotes does not crash', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'say "hello" to the world', session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[ROUTER]');
    });

    it('prompt with $(echo pwned) is treated as literal', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: '$(echo pwned)', session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('pwned');
    });

    it('prompt with backticks is treated as literal', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: '`echo pwned`', session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('pwned');
    });

    it('prompt with semicolons is treated as literal', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'hello; rm -rf /', session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[ROUTER]');
    });

    it('prompt with newlines does not corrupt stdout', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'line1\nline2\nline3', session_id: sid },
        { env: { FAKE_TIER: 'MEDIUM' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('[ROUTER]');
    });
  });

  describe('failure resilience', () => {
    it('malformed JSON on stdin → exit code 0, stdout is empty', async () => {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          const pathSep = process.platform === 'win32' ? ';' : ':';
          const child = spawn(process.execPath, [HOOK_PATH], {
            env: {
              ...(process.env as Record<string, string>),
              PATH: `${fakeBinDir}${pathSep}${process.env.PATH ?? ''}`,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.stdin.write('not valid json at all {{{');
          child.stdin.end();
          child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
        }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('empty stdin → exit code 0, stdout is empty', async () => {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
        (resolve) => {
          const pathSep = process.platform === 'win32' ? ';' : ':';
          const child = spawn(process.execPath, [HOOK_PATH], {
            env: {
              ...(process.env as Record<string, string>),
              PATH: `${fakeBinDir}${pathSep}${process.env.PATH ?? ''}`,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          child.stdin.end();
          child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
        }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('claude-router binary returns non-zero exit → exit code 0, stdout is empty', async () => {
      const sid = uid();
      const result = await runHook(
        { prompt: 'classify me', session_id: sid },
        { env: { FAKE_TIER: 'ERROR' } }
      );
      cleanupGuard(sid);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it('claude-router binary is missing from PATH → exit code 0, stdout is empty', async () => {
      // Use an isolated empty dir as PATH so claude-router is not found
      const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-isolated-'));
      try {
        const sid = uid();
        const result = await runHook(
          { prompt: 'classify me', session_id: sid },
          { env: { PATH: isolatedDir } }
        );
        cleanupGuard(sid);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('');
      } finally {
        fs.rmSync(isolatedDir, { recursive: true, force: true });
      }
    });

    it('claude-router binary hangs → hook is killable', async () => {
      const sid = uid();
      const start = Date.now();
      const result = await runHook(
        { prompt: 'classify me', session_id: sid },
        { env: { FAKE_TIER: 'HANG' }, timeout: 2000 }
      );
      cleanupGuard(sid);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(5000);
      expect(typeof result.stdout).toBe('string');
    }, 15000);
  });

  describe('concurrency', () => {
    it('hook invoked twice simultaneously → both complete independently', async () => {
      const sid1 = uid();
      const sid2 = uid();
      const [r1, r2] = await Promise.all([
        runHook({ prompt: 'concurrent test', session_id: sid1 }, { env: { FAKE_TIER: 'MEDIUM' } }),
        runHook({ prompt: 'concurrent test', session_id: sid2 }, { env: { FAKE_TIER: 'MEDIUM' } }),
      ]);
      cleanupGuard(sid1);
      cleanupGuard(sid2);
      expect(r1.exitCode).toBe(0);
      expect(r2.exitCode).toBe(0);
      expect(r1.stdout).toContain('[ROUTER] Complexity: MEDIUM');
      expect(r2.stdout).toContain('[ROUTER] Complexity: MEDIUM');
    });
  });
});
