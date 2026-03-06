#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(process.cwd(), 'public');

const SESSION_ROOTS = [
  { name: 'home', path: path.join(os.homedir(), '.codex', 'sessions') },
  { name: 'local', path: path.join(process.cwd(), 'sessions') }
];

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function isSubPath(parentPath, targetPath) {
  const relative = path.relative(parentPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function safeJsonParse(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringifyUnknown(value, maxLength = 8000) {
  if (value === null || value === undefined) {
    return '';
  }
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch {
            return String(value);
          }
        })();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...[truncated]`;
}

function createSessionId(source, relativePath) {
  return Buffer.from(JSON.stringify({ source, relativePath }), 'utf8').toString('base64url');
}

function decodeSessionId(encoded) {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.source === 'string' &&
      typeof parsed.relativePath === 'string'
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function isValidDateString(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function firstValidDate(...values) {
  for (const value of values) {
    if (isValidDateString(value)) {
      return value;
    }
  }
  return null;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFirstNonEmptyLine(filePath, maxBytes = 5 * 1024 * 1024) {
  const handle = await fsp.open(filePath, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  let carried = '';
  try {
    while (offset < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
      carried += buffer.toString('utf8', 0, bytesRead);
      const lines = carried.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i += 1) {
        if (lines[i].trim()) {
          return lines[i].trim();
        }
      }
      carried = lines[lines.length - 1];
    }
    return carried.trim() || null;
  } finally {
    await handle.close();
  }
}

async function walkJsonlFiles(rootPath) {
  const files = [];
  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(absolutePath);
      }
    }
  }
  return files;
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  const runners = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(runners);
  return results;
}

async function buildSessionDescriptor(root, filePath) {
  const stats = await fsp.stat(filePath);
  const firstLine = await readFirstNonEmptyLine(filePath);
  const firstRecord = safeJsonParse(firstLine);
  const sessionMeta =
    firstRecord &&
    firstRecord.type === 'session_meta' &&
    firstRecord.payload &&
    typeof firstRecord.payload === 'object'
      ? firstRecord.payload
      : {};
  const relativePath = toPosixPath(path.relative(root.path, filePath));
  const timestamp =
    firstValidDate(sessionMeta.timestamp, firstRecord && firstRecord.timestamp, stats.mtime.toISOString()) ||
    stats.mtime.toISOString();
  return {
    id: createSessionId(root.name, relativePath),
    source: root.name,
    relativePath,
    fileName: path.basename(filePath),
    filePath,
    timestamp,
    mtime: stats.mtime.toISOString(),
    sizeBytes: stats.size,
    meta: {
      sessionId: typeof sessionMeta.id === 'string' ? sessionMeta.id : null,
      cwd: typeof sessionMeta.cwd === 'string' ? sessionMeta.cwd : null,
      cliVersion: typeof sessionMeta.cli_version === 'string' ? sessionMeta.cli_version : null,
      originator: typeof sessionMeta.originator === 'string' ? sessionMeta.originator : null
    }
  };
}

function scoreSessionForSort(session) {
  const parsed = Date.parse(session.timestamp);
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  const fallback = Date.parse(session.mtime);
  return Number.isNaN(fallback) ? 0 : fallback;
}

async function listSessions() {
  const tasks = [];
  for (const root of SESSION_ROOTS) {
    if (!(await pathExists(root.path))) {
      continue;
    }
    const files = await walkJsonlFiles(root.path);
    for (const filePath of files) {
      tasks.push({ root, filePath });
    }
  }

  const descriptors = await mapWithConcurrency(tasks, 16, async (task) => {
    try {
      return await buildSessionDescriptor(task.root, task.filePath);
    } catch {
      return null;
    }
  });

  return descriptors
    .filter(Boolean)
    .sort((a, b) => scoreSessionForSort(b) - scoreSessionForSort(a))
    .map(serializeSessionDescriptor);
}

function serializeSessionDescriptor(descriptor) {
  return {
    id: descriptor.id,
    source: descriptor.source,
    relativePath: descriptor.relativePath,
    fileName: descriptor.fileName,
    timestamp: descriptor.timestamp,
    mtime: descriptor.mtime,
    sizeBytes: descriptor.sizeBytes,
    meta: descriptor.meta
  };
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return stringifyUnknown(content, 2000);
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) {
        parts.push(block.trim());
      }
      continue;
    }
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
      continue;
    }
    if (typeof block.message === 'string' && block.message.trim()) {
      parts.push(block.message.trim());
      continue;
    }
    if (typeof block.output === 'string' && block.output.trim()) {
      parts.push(block.output.trim());
      continue;
    }
    if (typeof block.input === 'string' && block.input.trim()) {
      parts.push(block.input.trim());
      continue;
    }
    if (typeof block.type === 'string' && block.type.includes('image')) {
      parts.push('[Image]');
      continue;
    }
    const fallback = stringifyUnknown(block, 1000).trim();
    if (fallback) {
      parts.push(fallback);
    }
  }
  return parts.join('\n\n').trim();
}

function extractReasoningText(payload) {
  if (Array.isArray(payload.summary)) {
    const summary = payload.summary
      .map((item) => {
        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text.trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (summary) {
      return summary;
    }
  }
  if (typeof payload.text === 'string' && payload.text.trim()) {
    return payload.text.trim();
  }
  if (payload.content) {
    const contentText = extractContentText(payload.content);
    if (contentText) {
      return contentText;
    }
  }
  return '[Reasoning details omitted by recorder]';
}

function normalizeRole(role) {
  if (typeof role !== 'string') {
    return 'event';
  }
  const normalized = role.toLowerCase();
  if (
    normalized === 'user' ||
    normalized === 'assistant' ||
    normalized === 'system' ||
    normalized === 'tool'
  ) {
    return normalized;
  }
  return normalized;
}

function formatFunctionArguments(argumentsText) {
  if (argumentsText === null || argumentsText === undefined) {
    return '';
  }
  if (typeof argumentsText !== 'string') {
    return stringifyUnknown(argumentsText, 4000);
  }
  const trimmed = argumentsText.trim();
  if (!trimmed) {
    return '';
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

function prettifyJsonInText(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }
  const trimmed = text.trim();
  if (trimmed) {
    try {
      if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      }
    } catch {
      // Keep original text when payload is not strict JSON.
    }
  }

  const lines = text.split('\n');
  let hasJsonLine = false;
  const formattedLines = lines.map((line) => {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) {
      return line;
    }
    try {
      if (
        (lineTrimmed.startsWith('{') && lineTrimmed.endsWith('}')) ||
        (lineTrimmed.startsWith('[') && lineTrimmed.endsWith(']'))
      ) {
        hasJsonLine = true;
        return JSON.stringify(JSON.parse(lineTrimmed), null, 2);
      }
    } catch {
      return line;
    }
    return line;
  });

  if (!hasJsonLine) {
    return text;
  }
  return formattedLines.join('\n');
}

function summarizeTurnContext(payload) {
  const bits = [];
  if (typeof payload.cwd === 'string' && payload.cwd) {
    bits.push(`cwd: ${payload.cwd}`);
  }
  if (typeof payload.model === 'string' && payload.model) {
    bits.push(`model: ${payload.model}`);
  }
  if (typeof payload.effort === 'string' && payload.effort) {
    bits.push(`effort: ${payload.effort}`);
  }
  if (typeof payload.approval_policy === 'string' && payload.approval_policy) {
    bits.push(`approval: ${payload.approval_policy}`);
  }
  if (payload.sandbox_policy && typeof payload.sandbox_policy === 'object') {
    if (typeof payload.sandbox_policy.type === 'string') {
      bits.push(`sandbox: ${payload.sandbox_policy.type}`);
    }
    if (typeof payload.sandbox_policy.network_access === 'boolean') {
      bits.push(`network_access: ${payload.sandbox_policy.network_access}`);
    }
  }
  return bits.length > 0 ? bits.join('\n') : 'Turn context update';
}

function summarizeTokenCount(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Token usage update';
  }
  const usage =
    (payload.info && payload.info.last_token_usage) ||
    (payload.info && payload.info.total_token_usage) ||
    null;
  if (!usage || typeof usage !== 'object') {
    return 'Token usage update';
  }
  const inputTokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens : '?';
  const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : '?';
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : '?';
  return `input: ${inputTokens}, output: ${outputTokens}, total: ${totalTokens}`;
}

function buildEntry(record, lineNumber) {
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  const baseEntry = {
    line: lineNumber,
    timestamp,
    role: 'event',
    label: 'Event',
    eventType: typeof record.type === 'string' ? record.type : 'unknown',
    text: '',
    primary: false
  };

  if (record.type === 'session_meta') {
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const details = [];
    if (typeof payload.id === 'string') {
      details.push(`id: ${payload.id}`);
    }
    if (typeof payload.cwd === 'string') {
      details.push(`cwd: ${payload.cwd}`);
    }
    if (typeof payload.originator === 'string') {
      details.push(`originator: ${payload.originator}`);
    }
    if (typeof payload.cli_version === 'string') {
      details.push(`cli_version: ${payload.cli_version}`);
    }
    if (typeof payload.timestamp === 'string') {
      details.push(`timestamp: ${payload.timestamp}`);
    }
    return {
      ...baseEntry,
      role: 'system',
      label: 'Session',
      eventType: 'session_meta',
      text: details.join('\n') || 'Session metadata'
    };
  }

  if (record.type === 'response_item') {
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const payloadType = typeof payload.type === 'string' ? payload.type : 'unknown';
    if (payloadType === 'message') {
      return {
        ...baseEntry,
        role: normalizeRole(payload.role),
        label: 'Message',
        eventType: `response_item/${payloadType}`,
        text: extractContentText(payload.content) || '[Empty message]',
        primary: true
      };
    }
    if (payloadType === 'function_call') {
      const pieces = [];
      if (typeof payload.name === 'string' && payload.name) {
        pieces.push(`tool: ${payload.name}`);
      }
      if (typeof payload.call_id === 'string' && payload.call_id) {
        pieces.push(`call_id: ${payload.call_id}`);
      }
      const args = formatFunctionArguments(payload.arguments);
      if (args) {
        pieces.push(`arguments:\n${args}`);
      }
      return {
        ...baseEntry,
        role: 'tool_call',
        label: 'Tool Call',
        eventType: `response_item/${payloadType}`,
        text: pieces.join('\n') || 'Tool call',
        primary: true
      };
    }
    if (payloadType === 'function_call_output') {
      const pieces = [];
      if (typeof payload.call_id === 'string' && payload.call_id) {
        pieces.push(`call_id: ${payload.call_id}`);
      }
      const outputText = prettifyJsonInText(stringifyUnknown(payload.output, 200000));
      if (outputText) {
        pieces.push(outputText);
      }
      return {
        ...baseEntry,
        role: 'tool_output',
        label: 'Tool Output',
        eventType: `response_item/${payloadType}`,
        text: pieces.join('\n') || 'Tool output',
        primary: true
      };
    }
    if (payloadType === 'reasoning') {
      return {
        ...baseEntry,
        role: 'reasoning',
        label: 'Reasoning',
        eventType: `response_item/${payloadType}`,
        text: extractReasoningText(payload),
        primary: true
      };
    }
    return {
      ...baseEntry,
      role: 'event',
      label: 'Response Item',
      eventType: `response_item/${payloadType}`,
      text: stringifyUnknown(payload, 3000)
    };
  }

  if (record.type === 'event_msg') {
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
    const payloadType = typeof payload.type === 'string' ? payload.type : 'unknown';
    if (payloadType === 'user_message') {
      return {
        ...baseEntry,
        role: 'user',
        label: 'User Event',
        eventType: `event_msg/${payloadType}`,
        text: typeof payload.message === 'string' ? payload.message : 'User event'
      };
    }
    if (payloadType === 'agent_message') {
      return {
        ...baseEntry,
        role: 'assistant',
        label: 'Assistant Event',
        eventType: `event_msg/${payloadType}`,
        text: typeof payload.message === 'string' ? payload.message : 'Assistant event'
      };
    }
    if (payloadType === 'agent_reasoning') {
      return {
        ...baseEntry,
        role: 'reasoning',
        label: 'Reasoning Event',
        eventType: `event_msg/${payloadType}`,
        text: typeof payload.text === 'string' ? payload.text : 'Reasoning update'
      };
    }
    if (payloadType === 'token_count') {
      return {
        ...baseEntry,
        role: 'metric',
        label: 'Token Count',
        eventType: `event_msg/${payloadType}`,
        text: summarizeTokenCount(payload)
      };
    }
    return {
      ...baseEntry,
      role: 'event',
      label: 'Event Message',
      eventType: `event_msg/${payloadType}`,
      text: stringifyUnknown(payload, 3000)
    };
  }

  if (record.type === 'turn_context') {
    return {
      ...baseEntry,
      role: 'context',
      label: 'Turn Context',
      eventType: 'turn_context',
      text: summarizeTurnContext(record.payload && typeof record.payload === 'object' ? record.payload : {})
    };
  }

  return {
    ...baseEntry,
    role: 'event',
    label: 'Record',
    text: stringifyUnknown(record.payload, 3000) || 'Unsupported record'
  };
}

async function parseSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = [];
  let lineBuffer = '';
  let lineNumber = 0;

  const pushLine = (line) => {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const parsed = safeJsonParse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      lines.push({
        line: lineNumber,
        timestamp: null,
        role: 'system',
        label: 'Parse Error',
        eventType: 'invalid_json',
        text: 'Unable to parse this line as JSON',
        primary: false
      });
      return;
    }
    lines.push(buildEntry(parsed, lineNumber));
  };

  for await (const chunk of stream) {
    lineBuffer += chunk;
    const split = lineBuffer.split(/\r?\n/);
    lineBuffer = split.pop();
    for (const line of split) {
      pushLine(line);
    }
  }
  if (lineBuffer.trim()) {
    pushLine(lineBuffer);
  }
  return lines;
}

async function resolveSessionDescriptor(encodedId) {
  const decoded = decodeSessionId(encodedId);
  if (!decoded) {
    return null;
  }
  const root = SESSION_ROOTS.find((candidate) => candidate.name === decoded.source);
  if (!root) {
    return null;
  }
  const relativePath = toPosixPath(decoded.relativePath);
  const absolutePath = path.resolve(root.path, relativePath);
  if (!isSubPath(root.path, absolutePath)) {
    return null;
  }
  if (!absolutePath.endsWith('.jsonl')) {
    return null;
  }
  if (!(await pathExists(absolutePath))) {
    return null;
  }
  return buildSessionDescriptor(root, absolutePath);
}

async function serveStaticFile(pathname, res) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!isSubPath(PUBLIC_DIR, filePath)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, 'Not Found');
    return;
  }
  if (!stat.isFile()) {
    sendText(res, 404, 'Not Found');
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const content = await fsp.readFile(filePath);
  res.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/sessions') {
      const sessions = await listSessions();
      sendJson(res, 200, {
        sources: SESSION_ROOTS.map((root) => ({ name: root.name, path: root.path })),
        sessions
      });
      return;
    }

    const detailMatch = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && detailMatch) {
      const encodedId = decodeURIComponent(detailMatch[1]);
      const sessionDescriptor = await resolveSessionDescriptor(encodedId);
      if (!sessionDescriptor) {
        sendJson(res, 404, { error: 'Session not found' });
        return;
      }
      const entries = await parseSessionFile(sessionDescriptor.filePath);
      const serialized = serializeSessionDescriptor(sessionDescriptor);
      sendJson(res, 200, {
        session: serialized,
        summary: {
          totalEntries: entries.length,
          primaryEntries: entries.filter((entry) => entry.primary).length
        },
        entries
      });
      return;
    }

    if (req.method === 'GET') {
      await serveStaticFile(requestUrl.pathname, res);
      return;
    }

    sendText(res, 405, 'Method Not Allowed');
  } catch (error) {
    sendJson(res, 500, {
      error: 'Internal server error',
      detail: error instanceof Error ? error.message : String(error)
    });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Codex Log UI running at http://${HOST}:${PORT}`);
    for (const source of SESSION_ROOTS) {
      console.log(`Source (${source.name}): ${source.path}`);
    }
  });
}

module.exports = {
  listSessions,
  parseSessionFile,
  resolveSessionDescriptor,
  createSessionId,
  decodeSessionId,
  buildSessionDescriptor
};
