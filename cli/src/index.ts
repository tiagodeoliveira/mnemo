#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { executePush } from './commands/push';
import { executeRecall, formatRecallOutput } from './commands/recall';
import { installHooks } from './commands/install-hooks';
import { detectProject } from './detect-project';
import { hookPromptSubmitFromStdin } from './commands/hook-prompt-submit';
import { hookSessionStartFromStdin } from './commands/hook-session-start';
import { localDate } from './date';

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
        apiKey: config.apiKey,
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
  .option('--facts', 'Include facts')
  .option('--episodes', 'Include episodes')
  .option('--about', 'Include about-me biographical profile')
  .option('--project [name]', 'Include project memories (auto-detected from git if no name given)')
  .option('--task <name>', 'Include task memories (e.g., coding, studying, meeting)')
  .option('--date <yyyy-mm-dd>', 'Include daily summary/log')
  .option('--daily', 'Include daily summary/log for today')
  .option('--all', 'Include all dimensions')
  .option('--format <mode>', 'Output format: visible (markdown) or hook (Claude Code JSON)', '')
  .action(async (opts) => {
    try {
      const config = loadConfig();

      const hasProject = opts.project !== undefined;
      const hasTask = opts.task !== undefined;
      const hasDate = opts.date !== undefined || opts.daily;
      const hasDimension = opts.preferences || opts.facts || opts.episodes || opts.about || hasProject || hasTask || hasDate || opts.all;

      if (!hasDimension) {
        program.commands.find((c) => c.name() === 'recall')!.help();
        return;
      }

      const project = hasProject
        ? (typeof opts.project === 'string' ? opts.project : detectProject())
        : opts.all ? detectProject() : undefined;

      const date = opts.date || (opts.daily || opts.all ? localDate() : undefined);

      const wantPreferences = opts.all || opts.preferences;
      const wantFacts = opts.all || opts.facts;
      const wantEpisodes = opts.all || opts.episodes;
      const wantAbout = opts.all || opts.about;

      const response = await executeRecall({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        workstation: config.workstation,
        preferences: wantPreferences,
        facts: wantFacts,
        episodes: wantEpisodes,
        about: wantAbout,
        project,
        task: opts.task || (opts.all ? 'coding' : undefined),
        date,
      });

      const visible = opts.format === 'hook' ? false : opts.format === 'visible' ? true : config.defaults.visible;
      const output = formatRecallOutput(response, { visible });
      if (output) process.stdout.write(output + '\n');
    } catch (err: unknown) {
      process.stderr.write(`mnemo recall error: ${err instanceof Error ? err.message : String(err)}\n`);
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
        console.log('Edit it with your API URL and key from the CDK deploy output.\n');
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

program.parse();
