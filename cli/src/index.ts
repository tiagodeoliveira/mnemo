#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './config';
import { executePush } from './commands/push';
import { executeRecall, formatRecallOutput } from './commands/recall';
import { detectProject } from './detect-project';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const project = opts.project || detectProject();

      const response = await executeRecall({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        project,
        workstation: config.workstation,
      });

      const output = formatRecallOutput(response, config.defaults.visible);
      if (output) process.stdout.write(output + '\n');
    } catch (err: any) {
      process.stderr.write(`mnemo recall error: ${err.message}\n`);
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Create default config file')
  .action(() => {
    const configDir = path.join(os.homedir(), '.mnemo');
    const configPath = path.join(configDir, 'config.json');

    if (fs.existsSync(configPath)) {
      console.log(`Config already exists at ${configPath}`);
      return;
    }

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          apiUrl: 'https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com/v1',
          apiKey: 'YOUR_API_KEY',
          workstation: os.hostname(),
          defaults: { visible: true },
        },
        null,
        2
      )
    );
    console.log(`Config created at ${configPath} — edit it with your API details.`);
  });

program.parse();
