import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const { getHomedir, setHomedir } = vi.hoisted(() => {
  let homedir = '';
  return {
    getHomedir: () => homedir,
    setHomedir: (v: string) => { homedir = v; },
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: getHomedir };
});

// Static imports — os.homedir is mocked so these use our tmpDir
import { logDecision, markFollowup, readEvents, hashPrompt } from '../../src/telemetry/logger';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'claude-router-telemetry-'));
  setHomedir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function eventsPath(): string {
  return path.join(tmpDir, '.claude-router', 'events.jsonl');
}

function eventsDir(): string {
  return path.join(tmpDir, '.claude-router');
}

function makeEvent(overrides?: Record<string, any>) {
  return {
    ts: new Date().toISOString(),
    session_id: 'test-session',
    prompt_hash: 'abc123def456',
    prompt_tokens: 10,
    tier: 'MEDIUM' as const,
    model: 'claude-sonnet-4-6',
    source: 'signal' as const,
    latency_ms: 42,
    manual_override: false,
    ...overrides,
  };
}

describe('telemetry e2e', () => {
  describe('write correctness', () => {
    it('logDecision writes exactly one JSONL line per call', () => {
      logDecision(makeEvent());
      const content = fs.readFileSync(eventsPath(), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
    });

    it('written line is valid JSON', () => {
      logDecision(makeEvent());
      const content = fs.readFileSync(eventsPath(), 'utf-8').trim();
      expect(() => JSON.parse(content)).not.toThrow();
    });

    it('written line contains all required fields with correct types', () => {
      logDecision(makeEvent());
      const parsed = JSON.parse(fs.readFileSync(eventsPath(), 'utf-8').trim());
      expect(typeof parsed.ts).toBe('string');
      expect(typeof parsed.session_id).toBe('string');
      expect(typeof parsed.prompt_hash).toBe('string');
      expect(typeof parsed.prompt_tokens).toBe('number');
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(parsed.tier);
      expect(typeof parsed.model).toBe('string');
      expect(['signal', 'haiku', 'fallback', 'override']).toContain(parsed.source);
      expect(typeof parsed.latency_ms).toBe('number');
      expect(typeof parsed.had_followup).toBe('boolean');
      expect(typeof parsed.manual_override).toBe('boolean');
    });

    it('ts field is valid ISO 8601', () => {
      logDecision(makeEvent());
      const parsed = JSON.parse(fs.readFileSync(eventsPath(), 'utf-8').trim());
      const date = new Date(parsed.ts);
      expect(date.toISOString()).toBe(parsed.ts);
    });

    it('prompt_hash is 12 hex characters', () => {
      const hash = hashPrompt('test prompt');
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });

    it('prompt_hash does not contain the original prompt text', () => {
      const prompt = 'my secret prompt text';
      const hash = hashPrompt(prompt);
      expect(hash).not.toContain('secret');
      expect(hash).not.toContain('prompt');
    });

    it('had_followup defaults to false on write', () => {
      logDecision(makeEvent());
      const parsed = JSON.parse(fs.readFileSync(eventsPath(), 'utf-8').trim());
      expect(parsed.had_followup).toBe(false);
    });

    it('manual_override is true when source is override', () => {
      logDecision(makeEvent({ source: 'override', manual_override: true }));
      const parsed = JSON.parse(fs.readFileSync(eventsPath(), 'utf-8').trim());
      expect(parsed.manual_override).toBe(true);
    });
  });

  describe('append behavior', () => {
    it('calling logDecision 3 times → file has exactly 3 lines', () => {
      logDecision(makeEvent({ ts: '2025-01-01T00:00:00.000Z' }));
      logDecision(makeEvent({ ts: '2025-01-01T00:00:01.000Z' }));
      logDecision(makeEvent({ ts: '2025-01-01T00:00:02.000Z' }));
      const content = fs.readFileSync(eventsPath(), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(3);
    });

    it('each line is independently valid JSON', () => {
      logDecision(makeEvent({ ts: '2025-01-01T00:00:00.000Z' }));
      logDecision(makeEvent({ ts: '2025-01-01T00:00:01.000Z' }));
      const lines = fs.readFileSync(eventsPath(), 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('lines are in chronological order', () => {
      logDecision(makeEvent({ ts: '2025-01-01T00:00:00.000Z' }));
      logDecision(makeEvent({ ts: '2025-01-01T00:00:05.000Z' }));
      const lines = fs.readFileSync(eventsPath(), 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      const ts0 = JSON.parse(lines[0]).ts;
      const ts1 = JSON.parse(lines[1]).ts;
      expect(ts0 < ts1).toBe(true);
    });
  });

  describe('directory creation', () => {
    it('directory does not exist → created automatically on first write', () => {
      expect(fs.existsSync(eventsDir())).toBe(false);
      logDecision(makeEvent());
      expect(fs.existsSync(eventsDir())).toBe(true);
      expect(fs.existsSync(eventsPath())).toBe(true);
    });

    it('directory already exists → no error, file appended correctly', () => {
      fs.mkdirSync(eventsDir(), { recursive: true });
      logDecision(makeEvent());
      expect(fs.existsSync(eventsPath())).toBe(true);
    });
  });

  describe('markFollowup', () => {
    it('after logDecision, markFollowup with matching session/ts → had_followup becomes true', () => {
      const ts = '2025-06-01T12:00:00.000Z';
      const sessionId = 'sess-1';
      logDecision(makeEvent({ ts, session_id: sessionId }));
      markFollowup(sessionId, ts);
      const events = readEvents();
      expect(events.length).toBe(1);
      expect(events[0].had_followup).toBe(true);
    });

    it('other lines unchanged after markFollowup', () => {
      logDecision(makeEvent({ ts: '2025-06-01T12:00:00.000Z', session_id: 'sess-1' }));
      logDecision(makeEvent({ ts: '2025-06-01T12:00:01.000Z', session_id: 'sess-2' }));
      markFollowup('sess-1', '2025-06-01T12:00:00.000Z');
      const events = readEvents();
      expect(events[0].had_followup).toBe(true);
      expect(events[1].had_followup).toBe(false);
    });

    it('markFollowup with non-matching session_id → no lines modified', () => {
      logDecision(makeEvent({ ts: '2025-06-01T12:00:00.000Z', session_id: 'sess-1' }));
      markFollowup('nonexistent', '2025-06-01T12:00:00.000Z');
      const events = readEvents();
      expect(events[0].had_followup).toBe(false);
    });

    it('markFollowup on missing file → no crash', () => {
      expect(() => markFollowup('sess-1', '2025-06-01T12:00:00.000Z')).not.toThrow();
    });
  });

  describe('resilience', () => {
    it('logDecision when directory is not writable → no exception propagates', () => {
      if (process.platform === 'win32') return; // chmod has no effect on NTFS
      fs.mkdirSync(eventsDir(), { recursive: true });
      fs.chmodSync(eventsDir(), 0o444);
      try {
        expect(() => logDecision(makeEvent())).not.toThrow();
      } finally {
        fs.chmodSync(eventsDir(), 0o755);
      }
    });

    it('logDecision when fs write fails → no exception propagates', () => {
      if (process.platform === 'win32') return; // chmod has no effect on NTFS
      fs.mkdirSync(eventsDir(), { recursive: true });
      fs.writeFileSync(eventsPath(), '', { mode: 0o444 });
      try {
        expect(() => logDecision(makeEvent())).not.toThrow();
      } finally {
        fs.chmodSync(eventsPath(), 0o644);
      }
    });

    it('reading corrupted JSONL skips bad line, processes rest', () => {
      fs.mkdirSync(eventsDir(), { recursive: true });
      const goodEvent = JSON.stringify({
        ts: '2025-06-01T12:00:00.000Z',
        session_id: 'sess-1',
        prompt_hash: 'abc123def456',
        prompt_tokens: 10,
        tier: 'LOW',
        model: 'claude-haiku-4-5-20251001',
        source: 'signal',
        latency_ms: 5,
        had_followup: false,
        manual_override: false,
      });
      const content = `${goodEvent}\nnot valid json\n${goodEvent}\n`;
      fs.writeFileSync(eventsPath(), content, 'utf-8');
      const events = readEvents();
      expect(events.length).toBe(2);
    });
  });

  describe('concurrency', () => {
    it('10 simultaneous logDecision calls → file has exactly 10 lines', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() =>
          logDecision(makeEvent({ ts: `2025-06-01T12:00:${String(i).padStart(2, '0')}.000Z` }))
        )
      );
      await Promise.all(promises);
      const content = fs.readFileSync(eventsPath(), 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(10);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('privacy', () => {
    it('no raw prompt text written to file', () => {
      logDecision(makeEvent({ prompt_hash: 'abc123def456' }));
      const content = fs.readFileSync(eventsPath(), 'utf-8');
      expect(content).not.toContain('super secret');
    });

    it('hashPrompt is deterministic', () => {
      const hash1 = hashPrompt('hello world');
      const hash2 = hashPrompt('hello world');
      expect(hash1).toBe(hash2);
    });

    it('hashPrompt differs for different inputs', () => {
      const hash1 = hashPrompt('hello world');
      const hash2 = hashPrompt('hello world!');
      expect(hash1).not.toBe(hash2);
    });
  });
});
