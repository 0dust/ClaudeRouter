import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';


function getSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readJsonFile(filePath: string): Record<string, any> {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, any>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function getHookPath(): string {
  return path.resolve(__dirname, '..', '..', 'hooks', 'user-prompt-submit.js');
}

function getRuntimeClaudeMdPath(): string {
  return path.resolve(__dirname, '..', '..', 'runtime-claude.md');
}

export function handleInit(args: string[]): void {
  try {
    console.log('ClaudeRouter init\n');

    // 1. Check dependencies
    console.log('Checking dependencies:');

    const major = parseInt(process.versions.node.split('.')[0], 10);
    if (major < 18) {
      process.stderr.write(`  ✗ Node.js ${process.versions.node} is too old — requires Node.js 18+\n`);
      process.exit(1);
    }
    console.log(`  ✓ Node.js ${process.versions.node}`);
    console.log('');

    // 2. Register the hook
    const settingsPath = getSettingsPath();
    const hookPath = getHookPath();

    if (!fs.existsSync(hookPath)) {
      process.stderr.write(`Hook script not found at ${hookPath}\n`);
      process.exit(1);
    }

    const settings = readJsonFile(settingsPath);

    if (!settings.hooks) {
      settings.hooks = {};
    }
    if (!Array.isArray(settings.hooks.UserPromptSubmit)) {
      settings.hooks.UserPromptSubmit = [];
    }

    // Use forward slashes so bash (which Claude Code uses on all platforms) handles
    // the path correctly. Quoting handles spaces (e.g. "Apps - Local" on Windows).
    const hookPathForShell = hookPath.replace(/\\/g, '/');
    const hookCommand = `node "${hookPathForShell}"`;

    const alreadyRegistered = settings.hooks.UserPromptSubmit.some((entry: any) => {
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h: any) => typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'));
      }
      return typeof entry === 'object' && entry.command && entry.command.includes('user-prompt-submit');
    });

    if (alreadyRegistered) {
      console.log('Hook already registered in ~/.claude/settings.json');
    } else {
      settings.hooks.UserPromptSubmit.push({
        matcher: '',
        hooks: [{ type: 'command', command: hookCommand }],
      });
      writeJsonFile(settingsPath, settings);
      console.log('Registered UserPromptSubmit hook in ~/.claude/settings.json');
    }

    // 3. Inject CLAUDE.md directives
    const targetDir = args[0] || process.cwd();
    const targetClaudeMd = path.join(targetDir, 'CLAUDE.md');
    const runtimePath = getRuntimeClaudeMdPath();

    if (!fs.existsSync(runtimePath)) {
      process.stderr.write(`Runtime CLAUDE.md not found at ${runtimePath}\n`);
      process.exit(1);
    }

    const routerContent = fs.readFileSync(runtimePath, 'utf-8');

    if (fs.existsSync(targetClaudeMd)) {
      let existing = fs.readFileSync(targetClaudeMd, 'utf-8');
      if (existing.includes('<!-- claude-router:start -->')) {
        // Replace existing block (idempotent update)
        existing = existing.replace(
          /<!-- claude-router:start -->[\s\S]*?<!-- claude-router:end -->/,
          routerContent.trim()
        );
        fs.writeFileSync(targetClaudeMd, existing, 'utf-8');
        console.log(`Updated router directives in ${targetClaudeMd}`);
      } else {
        // Append
        const separator = existing.endsWith('\n') ? '\n' : '\n\n';
        fs.writeFileSync(targetClaudeMd, existing + separator + routerContent, 'utf-8');
        console.log(`Appended router directives to ${targetClaudeMd}`);
      }
    } else {
      fs.writeFileSync(targetClaudeMd, routerContent, 'utf-8');
      console.log(`Created ${targetClaudeMd} with router directives`);
    }

    console.log('\nDone! ClaudeRouter is ready.');
  } catch (err: any) {
    process.stderr.write(`Error during init: ${err.message}\n`);
    process.exit(1);
  }
}

export function handleRemove(args: string[]): void {
  try {
    console.log('ClaudeRouter remove\n');

    // 1. Remove the hook from settings.json
    const settingsPath = getSettingsPath();

    if (fs.existsSync(settingsPath)) {
      const settings = readJsonFile(settingsPath);

      if (settings.hooks && Array.isArray(settings.hooks.UserPromptSubmit)) {
        settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter((entry: any) => {
          if (Array.isArray(entry.hooks)) {
            entry.hooks = entry.hooks.filter(
              (h: any) => !(typeof h === 'object' && h.command && h.command.includes('user-prompt-submit'))
            );
            return entry.hooks.length > 0;
          }
          return !(typeof entry === 'object' && entry.command && entry.command.includes('user-prompt-submit'));
        });

        if (settings.hooks.UserPromptSubmit.length === 0) {
          delete settings.hooks.UserPromptSubmit;
        }
        if (settings.hooks && Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }

        writeJsonFile(settingsPath, settings);
        console.log('Removed hook from ~/.claude/settings.json');
      } else {
        console.log('No hook found in ~/.claude/settings.json');
      }
    } else {
      console.log('No ~/.claude/settings.json found');
    }

    // 2. Remove CLAUDE.md section
    const targetDir = args[0] || process.cwd();
    const targetClaudeMd = path.join(targetDir, 'CLAUDE.md');

    if (fs.existsSync(targetClaudeMd)) {
      let content = fs.readFileSync(targetClaudeMd, 'utf-8');

      if (content.includes('<!-- claude-router:start -->')) {
        // Remove the block and any trailing blank line
        content = content.replace(
          /<!-- claude-router:start -->[\s\S]*?<!-- claude-router:end -->\n?/,
          ''
        );

        if (content.trim().length === 0) {
          fs.unlinkSync(targetClaudeMd);
          console.log(`Deleted empty ${targetClaudeMd}`);
        } else {
          fs.writeFileSync(targetClaudeMd, content, 'utf-8');
          console.log(`Removed router directives from ${targetClaudeMd}`);
        }
      } else {
        console.log(`No router directives found in ${targetClaudeMd}`);
      }
    } else {
      console.log(`No CLAUDE.md found at ${targetDir}`);
    }

    console.log('\nDone! ClaudeRouter has been removed.');
  } catch (err: any) {
    process.stderr.write(`Error during remove: ${err.message}\n`);
    process.exit(1);
  }
}
