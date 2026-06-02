import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const stateDir = path.join(os.homedir(), '.openclaw', 'state', 'mnemo-hook');
const logDir = path.join(os.homedir(), '.openclaw', 'logs');
const pendingFile = path.join(stateDir, 'pending.json');
const normalizedLogFile = path.join(logDir, 'mnemo-normalized.log');
const rawLogFile = path.join(logDir, 'mnemo-hook.log');
const pushLogFile = path.join(logDir, 'mnemo-push.log');
const hookDir = path.dirname(fileURLToPath(import.meta.url));
const hookEnvFile = path.join(hookDir, '.env');

async function readHookEnv() {
  try {
    return await fs.readFile(hookEnvFile, 'utf8');
  } catch {
    return '';
  }
}

function parseEnvLikeValue(content, key) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const name = trimmed.slice(0, idx).trim();
    if (name !== key) continue;
    return trimmed.slice(idx + 1).trim();
  }
  return '';
}

async function parseAllowedChannels() {
  const fileContent = await readHookEnv();
  const raw = process.env.MNEMO_OPENCLAW_CHANNELS || parseEnvLikeValue(fileContent, 'MNEMO_OPENCLAW_CHANNELS') || '';
  const values = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return values.length > 0 ? new Set(values) : null;
}

function isAllowedChannel(event, allowedChannels) {
  if (!allowedChannels) return true;
  const channel = String(event?.context?.channelId ?? '').trim().toLowerCase();
  return channel ? allowedChannels.has(channel) : false;
}

async function ensureDirs() {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
}

async function readPending() {
  try {
    return JSON.parse(await fs.readFile(pendingFile, 'utf8'));
  } catch {
    return {};
  }
}

async function writePending(data) {
  await fs.writeFile(pendingFile, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeConversationId(event) {
  const channel = event?.context?.channelId;
  const raw = event?.context?.conversationId;
  if (!raw) return null;
  return String(raw).includes(':') ? String(raw) : `${channel}:${raw}`;
}

function extractActor(context = {}) {
  const meta = context.metadata || {};
  if (context.channelId === 'telegram') {
    return {
      actorId: meta.senderId ?? null,
      actorName: meta.senderName ?? null,
      actorUsername: meta.senderUsername ?? null,
      actorPhone: null,
      threadId: meta.threadId ?? null,
    };
  }
  if (context.channelId === 'whatsapp') {
    return {
      actorId: meta.senderE164 ?? meta.senderId ?? null,
      actorName: meta.senderName ?? null,
      actorUsername: null,
      actorPhone: meta.senderE164 ?? null,
      threadId: null,
    };
  }
  return {
    actorId: meta.senderId ?? null,
    actorName: meta.senderName ?? null,
    actorUsername: meta.senderUsername ?? null,
    actorPhone: meta.senderE164 ?? null,
    threadId: meta.threadId ?? null,
  };
}

function buildPendingFromReceived(event) {
  const context = event.context || {};
  const actor = extractActor(context);
  return {
    receivedAt: event.timestamp instanceof Date ? event.timestamp.toISOString() : new Date().toISOString(),
    sessionKey: event.sessionKey ?? null,
    channel: context.channelId ?? null,
    accountId: context.accountId ?? null,
    conversationId: normalizeConversationId(event),
    from: context.from ?? null,
    userMessage: context.content ?? null,
    receivedMessageId: context.messageId ?? null,
    actor,
  };
}

function buildNormalizedExchange(received, sentEvent) {
  const sent = sentEvent.context || {};
  return {
    timestamp: sentEvent.timestamp instanceof Date ? sentEvent.timestamp.toISOString() : new Date().toISOString(),
    sessionKey: sentEvent.sessionKey ?? received.sessionKey ?? null,
    channel: sent.channelId ?? received.channel ?? null,
    accountId: sent.accountId ?? received.accountId ?? null,
    conversationId: normalizeConversationId(sentEvent) ?? received.conversationId ?? null,
    actorId: received.actor?.actorId ?? null,
    actorName: received.actor?.actorName ?? null,
    actorUsername: received.actor?.actorUsername ?? null,
    actorPhone: received.actor?.actorPhone ?? null,
    threadId: received.actor?.threadId ?? null,
    userMessage: received.userMessage ?? null,
    assistantMessage: sent.content ?? null,
    receivedMessageId: received.receivedMessageId ?? null,
    sentMessageId: sent.messageId ?? null,
    source: 'openclaw',
  };
}

function sanitizeSessionId(value) {
  const input = String(value ?? 'openclaw-session');
  let sanitized = input.replace(/[^a-zA-Z0-9-_]+/g, '-');
  sanitized = sanitized.replace(/-+/g, '-');
  sanitized = sanitized.replace(/^[-_]+/, '');
  if (!/^[a-zA-Z0-9]/.test(sanitized)) sanitized = `s-${sanitized}`;
  if (!sanitized) sanitized = 'openclaw-session';
  return sanitized;
}

function resolveWorkdir() {
  return process.env.MNEMO_OPENCLAW_WORKDIR || os.homedir();
}

function buildMnemoPushArgs(exchange) {
  const turns = [
    { role: 'user', content: exchange.userMessage ?? '' },
    { role: 'assistant', content: exchange.assistantMessage ?? '' },
  ];

  const source = exchange.channel ? `openclaw:${exchange.channel}` : 'openclaw';
  const workdir = resolveWorkdir();
  const sessionId = sanitizeSessionId(exchange.sessionKey);

  return [
    'push',
    '--session', sessionId,
    '--turns', JSON.stringify(turns),
    '--source', source,
    '--workdir', workdir,
  ];
}

async function appendJsonl(file, obj) {
  await fs.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

async function pushViaMnemoCli(exchange) {
  const args = buildMnemoPushArgs(exchange);
  try {
    const { stdout, stderr } = await execFileAsync('mnemo', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    await appendJsonl(pushLogFile, {
      timestamp: new Date().toISOString(),
      ok: true,
      sessionKey: exchange.sessionKey,
      source: `openclaw:${exchange.channel ?? 'unknown'}`,
      args,
      stdout,
      stderr,
    });
  } catch (error) {
    await appendJsonl(pushLogFile, {
      timestamp: new Date().toISOString(),
      ok: false,
      sessionKey: exchange.sessionKey,
      source: `openclaw:${exchange.channel ?? 'unknown'}`,
      args,
      error: {
        message: error?.message ?? String(error),
        stdout: error?.stdout ?? '',
        stderr: error?.stderr ?? '',
        code: error?.code ?? null,
      },
    });
  }
}

const logEvent = async (event) => {
  if (event?.type !== 'message') return;
  if (event?.action !== 'received' && event?.action !== 'sent') return;

  const allowedChannels = await parseAllowedChannels();
  if (!isAllowedChannel(event, allowedChannels)) return;

  await ensureDirs();

  const rawEntry = {
    timestamp: event?.timestamp instanceof Date ? event.timestamp.toISOString() : new Date().toISOString(),
    type: event?.type,
    action: event?.action,
    sessionKey: event?.sessionKey ?? null,
    context: event?.context ?? null,
  };
  await appendJsonl(rawLogFile, rawEntry);

  const pending = await readPending();
  const key = event.sessionKey || `fallback:${normalizeConversationId(event) || 'unknown'}`;

  if (event.action === 'received') {
    pending[key] = buildPendingFromReceived(event);
    await writePending(pending);
    return;
  }

  const match = pending[key];
  if (!match) return;

  const normalized = buildNormalizedExchange(match, event);
  await appendJsonl(normalizedLogFile, normalized);
  await pushViaMnemoCli(normalized);
  delete pending[key];
  await writePending(pending);
};

export default logEvent;
