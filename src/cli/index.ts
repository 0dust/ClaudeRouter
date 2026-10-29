#!/usr/bin/env node

import { route } from '../router/router';
import { loadConfig } from '../router/config';
import { logDecision, getSessionId, hashPrompt } from '../telemetry/logger';
import { recordRoutingEvent } from '../telemetry/feedback';
import { printStats } from './stats';
import { handleInit, handleRemove } from './init';
import { handleDoctor } from './doctor';

async function handleRoute(args: string[]): Promise<void> {
  let prompt: string;
  if (args.includes('--stdin')) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    prompt = Buffer.concat(chunks).toString('utf-8').trim();
  } else {
    prompt = args[0];
  }
  if (!prompt) {
    process.stderr.write('Usage: claude-router route <prompt> [--format model]\n');
    process.exit(1);
  }

  const formatIdx = args.indexOf('--format');
  const format = formatIdx !== -1 ? args[formatIdx + 1] : 'full';

  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx !== -1 ? args[cwdIdx + 1] : undefined;
  const config = loadConfig(cwd);
  const decision = await route(prompt, config);

  // Log telemetry
  const ts = new Date().toISOString();
  logDecision({
    ts,
    session_id: getSessionId(),
    prompt_hash: hashPrompt(prompt),
    prompt_tokens: prompt.trim().split(/\s+/).filter((t) => t.length > 0).length,
    tier: decision.tier,
    model: decision.model,
    source: decision.source,
    latency_ms: decision.latency_ms,
    manual_override: decision.source === 'override',
  });
  recordRoutingEvent(ts);

  if (format === 'model') {
    process.stdout.write(decision.model);
  } else if (format === 'directive') {
    process.stdout.write(decision.directive);
  } else {
    process.stdout.write(JSON.stringify(decision, null, 2) + '\n');
  }
}

function handleStats(args: string[]): void {
  const daysIdx = args.indexOf('--days');
  const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) : 7;
  printStats(isNaN(days) ? 7 : days);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'route':
      await handleRoute(args.slice(1));
      break;
    case 'stats':
      handleStats(args.slice(1));
      break;
    case 'init':
      handleInit(args.slice(1));
      break;
    case 'remove':
      handleRemove(args.slice(1));
      break;
    case 'doctor':
      handleDoctor();
      break;
    case '--version':
    case '-v': {
      const pkg = require('../../package.json');
      console.log(pkg.version);
      break;
    }
    case '--help':
    case '-h':
    case undefined:
      console.log(`claude-router — Intelligent model routing for Claude Code

Usage:
  claude-router route <prompt> [--stdin] [--format model|directive|full]
  claude-router stats [--days N]
  claude-router init [project-dir]    Set up hook and CLAUDE.md for a project
  claude-router remove [project-dir]  Remove hook and CLAUDE.md directives
  claude-router doctor                Verify installation health

Commands:
  route    Classify a prompt and return the routing decision
  stats    Show routing statistics for the last N days (default: 7)
  init     Register the UserPromptSubmit hook and inject CLAUDE.md directives
  remove   Remove the hook and CLAUDE.md directives
  doctor   Check Node version, hook registration, and file accessibility`);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
