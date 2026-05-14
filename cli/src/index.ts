#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { executePush } from './commands/push';
import { recallCmd } from './commands/recall';
import { searchCmd } from './commands/search';
import { installHooks } from './commands/install-hooks';
import { detectProject } from './detect-project';
import { hookPromptSubmitFromStdin } from './commands/hook-prompt-submit';
import { hookSessionStartFromStdin } from './commands/hook-session-start';
import { loginCmd } from './commands/login';

function collectAttr(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf('=');
  if (idx === -1) throw new Error(`--attr expects key=value, got "${value}"`);
  const key = value.slice(0, idx);
  const val = value.slice(idx + 1);
  if (!key) throw new Error(`--attr key is empty in "${value}"`);
  return { ...previous, [key]: val };
}

const program = new Command();

program
  .name('mnemo')
  .description('Centralized AI memory client')
  .version('0.1.0');

program
  .command('push')
  .description('Push conversation turns to memory')
  .requiredOption('--session <id>', 'Session ID')
  .requiredOption('--turns <json>', 'JSON array of conversation turns')
  .option('--project <name>', 'Project name (auto-detected from git)')
  .option('--source <name>', 'Source identifier (e.g., claude-code, meeting-tool)')
  .option('--workdir <path>', 'Working directory', process.cwd())
  .option('--attr <key=value...>', 'Arbitrary key=value attribute (repeatable)', collectAttr, {})
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const turns = JSON.parse(opts.turns);
      const project = opts.project || detectProject(opts.workdir);

      await executePush({
        apiUrl: config.apiUrl,
        auth0Domain: config.auth0Domain,
        auth0ClientId: config.auth0ClientId,
        sessionId: opts.session,
        turns,
        project,
        workstation: config.workstation,
        workdir: opts.workdir,
        source: opts.source,
        attributes: opts.attr,
      });
    } catch (err: unknown) {
      process.stderr.write(`mnemo push error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('recall')
  .description('Recall memories (pass one or more dimension flags)')
  .option('--preferences', 'Include preferences')
  .option('--episodes', 'Include episodes')
  .option('--about', 'Include about-me biographical profile')
  .option('--project [name]', 'Include project memories (auto-detected from git if no name given)')
  .option('--task <name>', 'Include task memories (e.g., coding, studying, meeting)')
  .option('--date <yyyy-mm-dd>', 'Include daily summary/log')
  .option('--daily', 'Include daily summary/log for today')
  .option('--meeting <id>', 'Include the categorized summary for a finalized meeting')
  .option('--all', 'Include all dimensions')
  .option('--q <query>', 'Rank records in each requested dimension by semantic similarity to this query')
  .option('--tags <csv>', 'Filter by tags (comma-separated)')
  .option('--tag-mode <mode>', 'Tag match mode: any (default) or all')
  .option('--since <date>', 'Include items updated at or after date (YYYY-MM-DD)')
  .option('--until <date>', 'Include items updated at or before date (YYYY-MM-DD)')
  .option('--limit <n>', 'Max items per dimension (default 50, max 200)', parseInt)
  .option('--min-similarity <n>', 'Minimum similarity threshold 0..1 (only with --q)', parseFloat)
  .option('--format <fmt>', 'Output format: text (default) or json')
  .action(async (opts) => {
    try {
      await recallCmd(opts);
    } catch (err: unknown) {
      process.stderr.write(`mnemo recall error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('search <query>')
  .description('Semantic search across all memories')
  .option('--dimension <name...>', 'Limit to specific dimensions (repeatable)')
  .option('--tags <csv>', 'Filter by tags (comma-separated)')
  .option('--tag-mode <mode>', 'Tag match mode: any (default) or all')
  .option('--namespace-prefix <prefix>', 'Limit to namespaces starting with prefix')
  .option('--since <date>', 'Items updated at or after date (YYYY-MM-DD)')
  .option('--until <date>', 'Items updated at or before date (YYYY-MM-DD)')
  .option('--limit <n>', 'Max results (default 10)', parseInt)
  .option('--min-similarity <n>', 'Filter below threshold (0..1)', parseFloat)
  .option('--format <fmt>', 'Output format: text (default) or json')
  .action(async (query, options) => {
    try {
      await searchCmd({
        q: query,
        dimensions: options.dimension,
        tags: options.tags?.split(','),
        tagMode: options.tagMode as 'any' | 'all',
        namespacePrefix: options.namespacePrefix,
        since: options.since,
        until: options.until,
        limit: options.limit ?? 10,
        minSimilarity: options.minSimilarity,
        format: options.format ?? 'text',
      });
    } catch (err: unknown) {
      process.stderr.write(`mnemo search error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('install')
  .description('Create mnemo config and install hooks for an AI client')
  .argument('<client>', 'Client to integrate with (claude-code, codex, gemini-cli, openclaw)')
  .option('--mnemo-hooks-dir <path>', 'Destination for client shim files (default ~/.mnemo/hooks)')
  .option('--openclaw-hooks-dir <path>', 'Destination OpenClaw hooks directory')
  .option('--channels <list>', 'Comma-separated OpenClaw channel allowlist')
  .option('--no-restart', 'Install/update OpenClaw hook files but do not restart the gateway')
  .option('--dry-run', 'Show planned OpenClaw changes without applying them')
  .option('--force', 'Rewrite existing mnemo hook entries and overwrite drifted hook files')
  .action((client, opts) => {
    try {
      const result = installHooks({
        client,
        mnemoHooksDir: opts.mnemoHooksDir,
        openclawHooksDir: opts.openclawHooksDir,
        channels: opts.channels,
        noRestart: opts.noRestart,
        dryRun: opts.dryRun,
        force: opts.force,
      });

      if (result.configCreated) {
        console.log(`Created mnemo config at ${result.mnemoConfigPath}`);
        console.log('Run `mnemo login` to authenticate.\n');
      } else {
        console.log(`mnemo config already exists at ${result.mnemoConfigPath}\n`);
      }

      if (client === 'openclaw') {
        if (opts.dryRun) {
          if (result.changesPlanned) {
            console.log(`Dry run: would install/update OpenClaw hook at ${result.openclawHookPath}.`);
            if (!opts.noRestart) console.log('Dry run: would run `openclaw gateway restart`.');
          } else {
            console.log(`Dry run: OpenClaw hook already up to date at ${result.openclawHookPath}.`);
          }
          return;
        }

        if (result.hooksInstalled) {
          console.log(`Installed OpenClaw hook at ${result.openclawHookPath}.`);
        } else {
          console.log(`OpenClaw hook already up to date at ${result.openclawHookPath}.`);
        }

        if (opts.noRestart) {
          console.log('Skipped OpenClaw gateway restart.');
        } else if (result.gatewayRestarted) {
          console.log('Restarted OpenClaw gateway.');
        } else if (result.gatewayCliMissing) {
          console.log(
            'Warning: `openclaw` CLI not found on PATH; skipping gateway restart. ' +
            'Run `openclaw gateway restart` manually once it is installed.'
          );
        }
      } else if (result.hooksInstalled) {
        const verb = opts.force ? 'Updated' : 'Installed';
        const promptEvent = client === 'gemini-cli' ? 'AfterAgent' : 'UserPromptSubmit';
        console.log(`${verb} ${client} hooks at ${result.installedHooksPath} (SessionStart + ${promptEvent}).`);
      } else {
        console.log(`${client} hooks already up to date at ${result.installedHooksPath}.`);
      }
    } catch (err: unknown) {
      process.stderr.write(`mnemo install error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

const hook = program
  .command('hook')
  .description('Handle AI client hook events (reads JSON from stdin)');

hook
  .command('prompt-submit')
  .description('Process UserPromptSubmit hook — parse transcript, extract turns, push to memory')
  .action(async () => {
    try {
      await hookPromptSubmitFromStdin();
    } catch (err: unknown) {
      process.stderr.write(`mnemo hook prompt-submit error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

hook
  .command('session-start')
  .description('Process SessionStart hook — recall memories and output hook JSON')
  .action(async () => {
    try {
      await hookSessionStartFromStdin();
    } catch (err: unknown) {
      process.stderr.write(`mnemo hook session-start error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program
  .command('login')
  .description('Authenticate via Auth0 device flow')
  .action(async () => {
    try {
      await loginCmd();
    } catch (err: unknown) {
      process.stderr.write(`mnemo login error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  });

program.parse();
