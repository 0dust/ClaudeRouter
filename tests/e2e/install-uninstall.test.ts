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

import { handleInit, handleRemove } from '../../src/cli/init';

let tmpDir: string;
let homeDir: string;
let projectDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'claude-router-install-'));
  homeDir = path.join(tmpDir, 'home');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  setHomedir(homeDir);

  vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function settingsPath(): string {
  return path.join(homeDir, '.claude', 'settings.json');
}

function readSettings(): any {
  return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
}

function claudeMdPath(): string {
  return path.join(projectDir, 'CLAUDE.md');
}

describe('install/uninstall e2e', () => {
  describe('install', () => {
    it('fresh install → hook appears exactly once in settings.json', () => {
      handleInit([projectDir]);
      expect(fs.existsSync(settingsPath())).toBe(true);
      const settings = readSettings();
      const hooks = settings.hooks.UserPromptSubmit;
      const routerHooks = hooks.filter(
        (entry: any) => Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'))
      );
      expect(routerHooks.length).toBe(1);
    });

    it('fresh install → ClaudeRouter section appears in CLAUDE.md', () => {
      handleInit([projectDir]);
      const content = fs.readFileSync(claudeMdPath(), 'utf-8');
      expect(content).toContain('ClaudeRouter Directives');
    });

    it('fresh install → marker comments present in CLAUDE.md', () => {
      handleInit([projectDir]);
      const content = fs.readFileSync(claudeMdPath(), 'utf-8');
      expect(content).toContain('<!-- claude-router:start -->');
      expect(content).toContain('<!-- claude-router:end -->');
    });

    it('install with existing settings.json with other hooks → other hooks preserved', () => {
      const dir = path.dirname(settingsPath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        settingsPath(),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: 'command', command: '/usr/bin/other-hook' }],
            PreToolUse: [{ type: 'command', command: '/usr/bin/pre-tool' }],
          },
        }),
        'utf-8'
      );
      handleInit([projectDir]);
      const settings = readSettings();
      const otherHook = settings.hooks.UserPromptSubmit.find(
        (h: any) => h.command === '/usr/bin/other-hook'
      );
      expect(otherHook).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
    });

    it('install with existing CLAUDE.md → user content preserved', () => {
      fs.writeFileSync(claudeMdPath(), '# My Project\n\nUser content here.\n', 'utf-8');
      handleInit([projectDir]);
      const content = fs.readFileSync(claudeMdPath(), 'utf-8');
      expect(content).toContain('# My Project');
      expect(content).toContain('User content here.');
      expect(content).toContain('<!-- claude-router:start -->');
    });

    it('install twice → hook appears exactly once (idempotent)', () => {
      handleInit([projectDir]);
      handleInit([projectDir]);
      const settings = readSettings();
      const hooks = settings.hooks.UserPromptSubmit;
      const routerHooks = hooks.filter(
        (entry: any) => Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'))
      );
      expect(routerHooks.length).toBe(1);
    });

    it('install twice → CLAUDE.md section appears exactly once (idempotent)', () => {
      handleInit([projectDir]);
      handleInit([projectDir]);
      const content = fs.readFileSync(claudeMdPath(), 'utf-8');
      const startCount = (content.match(/<!-- claude-router:start -->/g) || []).length;
      expect(startCount).toBe(1);
    });
  });

  describe('uninstall', () => {
    it('after install, uninstall → hook removed from settings.json', () => {
      handleInit([projectDir]);
      handleRemove([projectDir]);
      const settings = readSettings();
      const hooks = settings.hooks?.UserPromptSubmit ?? [];
      const routerHooks = hooks.filter(
        (entry: any) => Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'))
      );
      expect(routerHooks.length).toBe(0);
    });

    it('after install, uninstall → other hooks preserved', () => {
      const dir = path.dirname(settingsPath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        settingsPath(),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: 'command', command: '/usr/bin/other-hook' }],
          },
        }),
        'utf-8'
      );
      handleInit([projectDir]);
      handleRemove([projectDir]);
      const settings = readSettings();
      const otherHook = settings.hooks.UserPromptSubmit.find(
        (h: any) => h.command === '/usr/bin/other-hook'
      );
      expect(otherHook).toBeDefined();
    });

    it('after install, uninstall → ClaudeRouter section removed from CLAUDE.md', () => {
      handleInit([projectDir]);
      handleRemove([projectDir]);
      if (fs.existsSync(claudeMdPath())) {
        const content = fs.readFileSync(claudeMdPath(), 'utf-8');
        expect(content).not.toContain('<!-- claude-router:start -->');
      }
    });

    it('after install, uninstall → user content in CLAUDE.md preserved', () => {
      fs.writeFileSync(claudeMdPath(), '# My Project\n\nImportant docs.\n', 'utf-8');
      handleInit([projectDir]);
      handleRemove([projectDir]);
      expect(fs.existsSync(claudeMdPath())).toBe(true);
      const content = fs.readFileSync(claudeMdPath(), 'utf-8');
      expect(content).toContain('# My Project');
      expect(content).toContain('Important docs.');
    });

    it('after install, uninstall → events.jsonl preserved', () => {
      handleInit([projectDir]);
      const eventsDir = path.join(homeDir, '.claude-router');
      fs.mkdirSync(eventsDir, { recursive: true });
      fs.writeFileSync(path.join(eventsDir, 'events.jsonl'), '{"test":true}\n', 'utf-8');
      handleRemove([projectDir]);
      expect(fs.existsSync(path.join(eventsDir, 'events.jsonl'))).toBe(true);
    });

    it('uninstall without prior install → no crash', () => {
      expect(() => handleRemove([projectDir])).not.toThrow();
    });

    it('install → uninstall → install → works correctly (full cycle)', () => {
      handleInit([projectDir]);
      handleRemove([projectDir]);
      handleInit([projectDir]);
      const settings = readSettings();
      const hooks = settings.hooks.UserPromptSubmit;
      const routerHooks = hooks.filter(
        (entry: any) => Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'))
      );
      expect(routerHooks.length).toBe(1);
      const content = fs.readFileSync(claudeMdPath(), 'utf-8');
      expect(content).toContain('<!-- claude-router:start -->');
    });
  });

  describe('settings.json handling', () => {
    it('settings.json does not exist → created with correct structure', () => {
      handleInit([projectDir]);
      expect(fs.existsSync(settingsPath())).toBe(true);
      const settings = readSettings();
      expect(settings.hooks).toBeDefined();
      expect(Array.isArray(settings.hooks.UserPromptSubmit)).toBe(true);
    });

    it('settings.json is empty → handled gracefully', () => {
      const dir = path.dirname(settingsPath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath(), '', 'utf-8');
      handleInit([projectDir]);
      // readJsonFile returns {} for empty file, then init proceeds
      const settings = readSettings();
      expect(settings.hooks).toBeDefined();
    });

    it('settings.json has invalid JSON → handled gracefully', () => {
      const dir = path.dirname(settingsPath());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath(), '{invalid json', 'utf-8');
      // readJsonFile returns {} for invalid JSON, then init proceeds
      handleInit([projectDir]);
      const settings = readSettings();
      expect(settings.hooks).toBeDefined();
    });
  });
});
