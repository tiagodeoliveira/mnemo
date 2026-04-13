#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { executePush } from './commands/push';
import { executeRecall, formatRecallOutput } from './commands/recall';
import { installHooks } from './commands/install-hooks';
import { detectProject } from './detect-project';

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
      });
    } catch (err: any) {
      process.stderr.write(`mnemo push error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('recall')
  .description('Recall memories for current context')
  .option('--project <name>', 'Project name (auto-detected from git)')
  .option('--task <name>', 'Task domain (e.g., coding, studying, meeting)')
  .option('--date <yyyy-mm-dd>', 'Date for daily summary')
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const project = opts.project || detectProject();

      const response = await executeRecall({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        project,
        workstation: config.workstation,
        task: opts.task,
        date: opts.date,
      });

      const output = formatRecallOutput(response, config.defaults.visible);
      if (output) process.stdout.write(output + '\n');
    } catch (err: any) {
      process.stderr.write(`mnemo recall error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('install')
  .description('Create mnemo config and install Claude Code hooks')
  .option('--hooks-dir <path>', 'Path to hooks directory')
  .action((opts) => {
    try {
      const result = installHooks({
        hooksDir: opts.hooksDir,
      });

      if (result.configCreated) {
        console.log(`Created mnemo config at ${result.mnemoConfigPath}`);
        console.log('Edit it with your API URL and key from the CDK deploy output.\n');
      } else {
        console.log(`mnemo config already exists at ${result.mnemoConfigPath}\n`);
      }

      if (result.hooksInstalled) {
        console.log('Installed Claude Code hooks (SessionStart + UserPromptSubmit).');
      } else {
        console.log('Claude Code hooks already installed — skipped.');
      }
    } catch (err: any) {
      process.stderr.write(`mnemo install error: ${err.message}\n`);
      process.exit(1);
    }
  });

program.parse();
