#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// On Windows, .cmd files in PATH require shell:true to be found by spawnSync
const SHELL = process.platform === 'win32';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  try {
    run(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    process.exit(0);
  }
});

function run(raw) {
  if (!raw || !raw.trim()) process.exit(0);

  // Check claude-router is available before doing any work
  const check = spawnSync('claude-router', ['--version'], { stdio: 'pipe', timeout: 5000, shell: SHELL });
  if (check.error || check.status === null) process.exit(0);

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // File-based depth guard — prevents re-entrant classification loops
  const rawId = String(input.session_id || 'default');
  const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const guardFile = path.join(os.tmpdir(), `.claude-router-guard-${safeId}`);

  if (fs.existsSync(guardFile)) {
    try {
      const ageMs = Date.now() - fs.statSync(guardFile).mtimeMs;
      if (ageMs < 5000) process.exit(0);
    } catch {
      // ignore stat errors
    }
  }
  try { fs.writeFileSync(guardFile, ''); } catch { /* ignore */ }

  // Subagent check (belt-and-suspenders)
  if (input.is_subagent === true) process.exit(0);

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (!prompt || !prompt.trim()) process.exit(0);
  if (prompt.length > 100000) process.exit(0);

  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;

  const args = ['route', '--stdin', '--format', 'directive'];
  if (cwd) args.push('--cwd', cwd);

  const result = spawnSync('claude-router', args, {
    input: prompt,
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: SHELL,
  });

  if (result.error || result.status !== 0) process.exit(0);

  const directive = (result.stdout || '').trim();
  if (!directive) process.exit(0);

  // Suppress HIGH tier — Claude handles these directly
  if (directive.includes('Complexity: HIGH') || directive.includes('Handle this task directly')) {
    process.exit(0);
  }

  process.stdout.write(directive + '\n');
  process.exit(0);
}
