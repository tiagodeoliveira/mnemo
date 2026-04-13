#!/usr/bin/env npx tsx
/**
 * Cleanup script — retrieves all memory records from known namespaces and deletes them.
 * Usage: npx tsx scripts/cleanup-memory.ts
 *        MEMORY_ID=xxx ACTOR_ID=yyy npx tsx scripts/cleanup-memory.ts
 *
 * Auto-discovers MEMORY_ID and ACTOR_ID from the deployed MnemoStack Lambda
 * configuration via AWS CLI, or reads from env vars if provided.
 */

import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
  DeleteMemoryRecordCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { execFileSync } from 'child_process';

const client = new BedrockAgentCoreClient({});

interface Config {
  memoryId: string;
  actorId: string;
}

function loadConfig(): Config {
  if (process.env.MEMORY_ID && process.env.ACTOR_ID) {
    return { memoryId: process.env.MEMORY_ID, actorId: process.env.ACTOR_ID };
  }

  // Auto-discover from deployed Lambda env vars via AWS CLI
  try {
    const fnName = execFileSync('aws', [
      'lambda', 'list-functions',
      '--query', "Functions[?contains(FunctionName, 'IngestFn')].FunctionName | [0]",
      '--output', 'text',
    ], { encoding: 'utf-8' }).trim();

    const envJson = execFileSync('aws', [
      'lambda', 'get-function-configuration',
      '--function-name', fnName,
      '--query', 'Environment.Variables',
      '--output', 'json',
    ], { encoding: 'utf-8' }).trim();

    const env = JSON.parse(envJson);
    return { memoryId: env.MEMORY_ID || '', actorId: env.ACTOR_ID || '' };
  } catch {
    throw new Error('Could not auto-discover config. Set MEMORY_ID and ACTOR_ID env vars.');
  }
}

async function retrieveRecordIds(memoryId: string, namespace: string): Promise<string[]> {
  try {
    const result = await client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId,
        namespace,
        searchCriteria: {
          searchQuery: 'all records',
          topK: 100,
        },
      })
    );
    return (result.memoryRecordSummaries || [])
      .map((s: any) => s.memoryRecordId)
      .filter(Boolean);
  } catch (err: any) {
    if (err.name === 'ResourceNotFoundException') return [];
    console.warn(`  Warning: failed to query ${namespace}: ${err.message}`);
    return [];
  }
}

async function deleteRecord(memoryId: string, recordId: string): Promise<boolean> {
  try {
    await client.send(
      new DeleteMemoryRecordCommand({ memoryId, memoryRecordId: recordId })
    );
    return true;
  } catch (err: any) {
    console.warn(`  Warning: failed to delete ${recordId}: ${err.message}`);
    return false;
  }
}

async function main() {
  const { memoryId, actorId } = loadConfig();
  if (!memoryId || !actorId) {
    console.error('ERROR: memoryId and actorId required. Set in ~/.mnemo/config.json or env vars.');
    process.exit(1);
  }

  console.log(`Cleaning up memory records for actor=${actorId}, memory=${memoryId}\n`);

  const namespaces = [
    `/preferences/${actorId}/`,
    `/facts/${actorId}/`,
    `/episodes/${actorId}/`,
    `/projects/${actorId}/mnemo/`,
    `/projects/${actorId}/claude_code/`,
    `/tasks/${actorId}/coding/`,
    `/tasks/${actorId}/studying/`,
    `/tasks/${actorId}/meeting/`,
    `/tasks/${actorId}/general/`,
    `/daily/${actorId}/${new Date().toISOString().slice(0, 10)}/`,
  ];

  let totalDeleted = 0;

  for (const ns of namespaces) {
    const ids = await retrieveRecordIds(memoryId, ns);
    if (ids.length === 0) {
      console.log(`  ${ns} — no records`);
      continue;
    }

    console.log(`  ${ns} — ${ids.length} records, deleting...`);
    let deleted = 0;
    for (const id of ids) {
      if (await deleteRecord(memoryId, id)) deleted++;
    }
    totalDeleted += deleted;
    console.log(`    deleted ${deleted}/${ids.length}`);
  }

  console.log(`\nDone. Deleted ${totalDeleted} total records.`);
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
