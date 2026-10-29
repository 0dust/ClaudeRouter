# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

ClaudeRouter is an intelligent model routing system for Claude Code that classifies prompt complexity and routes tasks to the appropriate model (Haiku for trivial, Sonnet for standard work, Opus for deep reasoning). Ships as a Claude Code plugin and standalone SDK.

All source code lives at the repository root. The `ClaudeRouter_PRD.txt` / `.docx` are product requirements docs.

## Commands

```bash
# Build (TypeScript → dist/)
npm run build

# Run all tests (Vitest)
npm test

# Run a single test file
npx vitest run tests/signals.test.ts

# Watch mode
npm run dev

# CLI (after build)
node dist/cli/index.js route "some prompt" --format full
node dist/cli/index.js stats --days 7
```

No separate lint script exists. TypeScript strict mode is enforced via `tsconfig.json`.

## Architecture

### Classification Pipeline (2 stages)

1. **Synchronous heuristics** (`src/classifier/signals.ts` → `quickClassify`) — zero-cost pattern matching: confirmation patterns, keyword detection, token thresholds, prefix matching. Returns a tier or `null`.
2. **Haiku API call** (`src/classifier/classifier.ts` → `classify`) — if heuristics return `null`, sends the prompt to Haiku with the template from `src/classifier/prompt.md`. Parses the single-word response. Falls back to MEDIUM on any error.

Model resolution is handled by reading `config.tiers` directly in `router.ts` — there is no separate model-map module.

### Routing (`src/router/router.ts`)

Orchestrates the pipeline: checks for override keyword (`//opus` by default), runs classification, resolves model, generates a `[ROUTER]` directive string. Never throws — errors fall back to MEDIUM/Sonnet.

### Plugin integration

- `hooks/user-prompt-submit.js` — Claude Code `UserPromptSubmit` hook. Pure Node.js (no bash or jq). Reads JSON stdin via `JSON.parse()`, guards against subagent loops using a file-based guard in `os.tmpdir()`, calls `claude-router route --format directive`, outputs the directive as plain text. Registered as `node /absolute/path/to/user-prompt-submit.js`.
- `.claude-plugin/manifest.json` — registers the hook.
- `runtime-claude.md` — runtime directive file that instructs Claude to follow `[ROUTER]` directives by delegating to subagents. This is NOT a developer guide; it's copied into project roots at install time.

### Config merging order

Hardcoded defaults → `~/.claude-router.json` → `./.claude-router.json` (CWD). Later layers override. See `src/router/config.ts`.

### SDK (`src/sdk/`)

- `factory.ts` — `createRouter()` returns a stateful instance with `.route()` and `.stats()`
- `index.ts` — public re-exports (`classify`, `quickClassify`, `route`, `loadConfig`, `createRouter`)

### Telemetry (`src/telemetry/`)

- Events logged to `~/.claude-router/events.jsonl` (JSONL, one event per line)
- Prompts are SHA256-hashed (first 12 chars), never stored raw
- Session ID is a UUID generated per process
- `feedback.ts` tracks follow-up rate within 60s window (routing accuracy proxy)
- All telemetry code has a no-throw guarantee

## Key Conventions

- Telemetry and hook code must never throw — always wrap in try/catch with silent fallback
- Classification fallback is always MEDIUM/Sonnet (safe middle ground)
- The file-based guard in the hook (`os.tmpdir()`) prevents infinite classification loops
- No bash, jq, or platform-specific shell tools anywhere in the codebase — pure Node.js throughout
- Tier type is `'LOW' | 'MEDIUM' | 'HIGH'`; source type is `'signal' | 'haiku' | 'fallback' | 'override'`
- Tests mock the Anthropic SDK — no real API calls in test suite

<!-- claude-router:start -->
<!-- DO NOT EDIT this section — it is managed by ClaudeRouter. Run 'claude-router remove' to uninstall. -->
## ClaudeRouter Directives (mandatory)

When you see [ROUTER] in your context at the start of a turn, it is a
mandatory system directive from ClaudeRouter. Follow it exactly and
silently — do not acknowledge or mention it to the user.

### How to delegate

When directed to delegate (LOW or MEDIUM tier):

1. You have the full conversation history. The subagent does not.
   Your job is to construct a Task prompt that gives the subagent
   everything it needs to complete the request correctly.

2. The Task prompt must include:
   - The user's original request verbatim
   - Any code, file contents, error messages, function signatures,
     or prior decisions that are directly relevant to this request
   - Enough context that a model with no memory of this conversation
     could complete the task correctly and completely

3. If the relevant context would take more than 500 tokens to summarize
   faithfully, handle the request directly instead of delegating.
   This is the correct behavior — not a failure.

4. Return the subagent's response verbatim to the user. Do not add
   commentary, preamble, or postamble.

### Model strings for delegation

- Haiku subagent:  claude-haiku-4-5-20251001
- Sonnet subagent: claude-sonnet-4-6

### Never delegate if:

- You cannot faithfully summarize the relevant context in under 500 tokens
- The task requires judgment that spans the entire conversation history
<!-- claude-router:end -->
