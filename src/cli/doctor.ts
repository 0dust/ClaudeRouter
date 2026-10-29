import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface Check {
  label: string;
  pass: boolean;
  detail?: string;
}

function checkNodeVersion(): Check {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  return {
    label: 'Node.js >= 18',
    pass: major >= 18,
    detail: `found v${process.versions.node}`,
  };
}

function checkHookRegistered(): Check {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    const hooks = settings?.hooks?.UserPromptSubmit;
    if (Array.isArray(hooks)) {
      const found = hooks.some((entry: any) => {
        if (Array.isArray(entry.hooks)) {
          return entry.hooks.some((h: any) => typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'));
        }
        return typeof entry === 'object' && entry.command && entry.command.includes('user-prompt-submit');
      });
      if (found) {
        return { label: 'Hook registered in ~/.claude/settings.json', pass: true };
      }
    }
    return { label: 'Hook registered in ~/.claude/settings.json', pass: false, detail: 'not found' };
  } catch {
    return { label: 'Hook registered in ~/.claude/settings.json', pass: false, detail: 'settings.json not readable' };
  }
}

function checkClaudeMdMarker(): Check {
  const claudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
  try {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const hasMarker = content.includes('<!-- claude-router:start -->');
    return {
      label: 'CLAUDE.md has claude-router marker in CWD',
      pass: hasMarker,
      detail: hasMarker ? undefined : 'marker not found',
    };
  } catch {
    return { label: 'CLAUDE.md has claude-router marker in CWD', pass: false, detail: 'CLAUDE.md not found' };
  }
}

function checkRuntimeClaudeMd(): Check {
  const runtimePath = path.resolve(__dirname, '..', '..', 'runtime-claude.md');
  const exists = fs.existsSync(runtimePath);
  return {
    label: 'runtime-claude.md accessible',
    pass: exists,
    detail: exists ? undefined : `not found at ${runtimePath}`,
  };
}

function checkPromptMd(): Check {
  const candidates = [
    path.join(__dirname, '..', 'classifier', 'prompt.md'),
    path.join(__dirname, 'prompt.md'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { label: 'prompt.md accessible', pass: true };
    }
  }
  return { label: 'prompt.md accessible', pass: false, detail: 'not found (inline fallback will be used)' };
}

export function handleDoctor(): void {
  console.log('ClaudeRouter doctor\n');

  const checks: Check[] = [
    checkNodeVersion(),
    checkHookRegistered(),
    checkClaudeMdMarker(),
    checkRuntimeClaudeMd(),
    checkPromptMd(),
  ];

  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? '✓' : '✗';
    const suffix = check.detail ? ` (${check.detail})` : '';
    console.log(`  ${icon} ${check.label}${suffix}`);
    if (!check.pass) allPass = false;
  }

  console.log('');
  if (allPass) {
    console.log('All checks passed.');
  } else {
    console.log('Some checks failed. Run `claude-router init <project-dir>` to fix setup issues.');
    process.exit(1);
  }
}
