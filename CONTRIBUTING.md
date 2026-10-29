# Contributing to ClaudeRouter

## Local development setup

```bash
git clone https://github.com/0dust/ClaudeRouter.git
cd ClaudeRouter
npm install
npm run build
```

To iterate without reinstalling globally, run the CLI directly from the build output:

```bash
node dist/cli/index.js route "your prompt here" --format full
```

To install globally from source (the published package is scoped as `@0dust/claude-router` on npm):

```bash
npm install -g .
```

### Running tests

```bash
npm test                              # run all tests
npx vitest run tests/signals.test.ts  # run a single file
npx vitest                            # watch mode
```

Tests mock the Anthropic SDK — no `ANTHROPIC_API_KEY` is needed to run them.

### Testing the plugin hook locally

The hook script reads JSON from stdin and writes a directive to stdout:

```bash
echo '{"prompt": "add a login endpoint", "is_subagent": false}' \
  | node hooks/user-prompt-submit.js
```

To load the plugin into a live Claude Code session without reinstalling globally, use the `--plugin-dir` flag:

```bash
claude --plugin-dir /path/to/claude-router
```

This loads the plugin for that session only.

## Project structure

```
src/
  classifier/
    signals.ts      # synchronous heuristics (quickClassify) — no API call
    classifier.ts   # full classify(): runs signals, then falls back to Haiku
    prompt.md       # classification prompt template for Haiku
  router/
    router.ts       # route(): orchestrates classify + model resolution
    config.ts       # loadConfig(): merges defaults → ~/.claude-router.json → CWD
  cli/
    index.ts        # CLI entry (route, stats, init, remove, doctor commands)
    stats.ts        # printStats(): reads events.jsonl and formats output
  sdk/
    factory.ts      # createRouter(): stateful router with session stats
    index.ts        # public re-exports
  telemetry/
    logger.ts       # logDecision(): writes to ~/.claude-router/events.jsonl
    feedback.ts     # recordRoutingEvent(): tracks follow-up rate
hooks/
  user-prompt-submit.js  # Claude Code UserPromptSubmit hook (pure Node.js)
  hooks.json             # hook registration (read by plugin system)
.claude-plugin/
  plugin.json            # plugin metadata (name, version, description)
tests/
  signals.test.ts    # quickClassify heuristic coverage
  classifier.test.ts # full classify() with mocked Anthropic SDK
  router.test.ts     # routing, config merging, conservative mode
```

## Adding or tuning signal heuristics

All fast-path heuristics live in `src/classifier/signals.ts`. `quickClassify` returns a `Tier` or `null` — `null` means "fall through to Haiku". When adding patterns:

- Prefer returning `null` over a wrong tier — Haiku is cheap, misrouting is not
- Add corresponding test cases in `tests/signals.test.ts`
- Check that existing tests still pass: `npm test`

## Changing the classification prompt

Edit `src/classifier/prompt.md`. The template must contain `{{PROMPT}}` as the placeholder. Haiku is instructed to return exactly one word (`LOW`, `MEDIUM`, or `HIGH`). `parseTier` in `classifier.ts` handles minor deviations but keep the prompt tightly constrained.

## Configuration schema

`RouterConfig` is defined in `src/router/config.ts`. Adding a new field requires:

1. Add it to the `RouterConfig` interface
2. Add a default in `DEFAULTS`
3. Handle it in `deepMerge`

## Telemetry

Events are appended to `~/.claude-router/events.jsonl`. Each line is a `RoutingEvent` (see `src/telemetry/logger.ts`). Raw prompts are never stored — only a 12-char SHA256 prefix. Telemetry code must never throw; wrap everything in try/catch with a silent fallback.
