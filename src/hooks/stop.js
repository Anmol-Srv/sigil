#!/usr/bin/env node

/**
 * Stop hook — auto-extracts memorable content from the last user message
 * after Claude finishes a turn.
 *
 * Why this exists: relying on Claude to call `sigil remember` proactively is
 * unreliable. The model sometimes saves preferences and decisions, sometimes
 * doesn't. This hook is the safety net — it runs after every assistant turn
 * completes, scans the latest user message with a small LLM classifier, and
 * saves anything memorable through the same AUDM pipeline `sigil remember`
 * uses. Duplicates are deduped automatically.
 *
 * Cost: one Haiku call per turn (~$0.0001, ~300ms). Runs async after the
 * user has already seen Claude's response, so user-facing latency is zero.
 */

import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

import { loadHookEnv } from './env-loader.js';
import { maskSecrets } from './secret-mask.js';
import { classifyTurn } from './stop-classify.js';
import { appendSpool } from './stop-spool.js';
import { breakerOpen, tripBreaker, resetBreaker } from './daemon-breaker.js';
import { readStdin } from './io.js';
import { hookAgent, normalizeInput, markSeen, takePrompt, DEFAULT_AGENT } from './host.js';
import { SIGIL_STOP_CURSOR, SIGIL_HOME } from '../lib/paths.js';

loadHookEnv();
const AGENT = hookAgent();

const MIN_MESSAGE_LENGTH = 15;
const MAX_MESSAGE_LENGTH = 8000;
const CURSOR_PATH = SIGIL_STOP_CURSOR;
// The Stop hook is async (Claude has already responded), budget ~30s. Bound the
// daemon save so a slow/wedged daemon spools the turn instead of hanging; a cold
// spawn is capped at ~5s on top, leaving margin under the budget.
const SAVE_TIMEOUT_MS = 20_000;

// Agents whose Stop hook blocks would wait on the classifier before the user
// can continue: Cursor has no background hooks, and Codex skipped its async
// Stop hook in `codex exec`. Hand the turn to a detached copy of this hook and
// answer at once. (Claude Code runs this hook with async: true.)
const DETACH_AGENTS = new Set(['cursor', 'codex-cli']);
const PAYLOAD_ENV = 'SIGIL_STOP_PAYLOAD';

function detachSelf(raw) {
  try {
    const dir = join(SIGIL_HOME, 'run');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `stop-${process.pid}-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(file, raw, { mode: 0o600 });
    const child = spawn(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [PAYLOAD_ENV]: file },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function readPayload() {
  const file = process.env[PAYLOAD_ENV];
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } finally { rmSync(file, { force: true }); }
}

async function main() {
  const raw = process.env[PAYLOAD_ENV] ? readPayload() : await readStdin();
  if (!raw) return respond();
  if (DETACH_AGENTS.has(AGENT) && !process.env[PAYLOAD_ENV] && detachSelf(raw)) return respond();

  let input;
  try { input = JSON.parse(raw); } catch { return respond(); }
  markSeen(AGENT, 'stop');
  // Downstream code (spool, save) reads the Claude Code field names.
  const { sessionId, cwd } = normalizeInput(input);
  input = { ...input, session_id: sessionId, cwd };

  const userMessage = await extractLastUserMessage(input);
  if (!userMessage) return respond();
  if (userMessage.length < MIN_MESSAGE_LENGTH) return respond();
  if (userMessage.length > MAX_MESSAGE_LENGTH) return respond();

  // Skip if we already processed this exact message
  const messageHash = sha256(userMessage);
  if (alreadyProcessed(messageHash)) return respond();

  // Config gate — bail before the LLM classifier call if config is known-broken.
  // Spool the turn so it's replayed once config is fixed, instead of dropping it.
  const { failClosedOnBadConfig } = await import('./error-log.js');
  if (await failClosedOnBadConfig('stop', raw)) {
    appendSpool({
      message: userMessage,
      sessionId: input.session_id,
      cwd: input.cwd || null,
      transcriptPath: input.transcript_path || null,
      reason: 'bad-config',
    });
    markProcessed(messageHash);
    return respond();
  }

  // Circuit breaker (F5): a recent hook found the daemon wedged. Don't classify
  // (an LLM call) or poke the daemon — spool the raw turn for replay once it
  // recovers. This is what keeps a wedged daemon from being hammered every turn.
  if (breakerOpen()) {
    appendSpool({
      message: userMessage,
      sessionId: input.session_id,
      cwd: input.cwd || null,
      transcriptPath: input.transcript_path || null,
      reason: 'daemon-breaker',
    });
    markProcessed(messageHash);
    process.stderr.write('[sigil:stop] daemon breaker open — spooled turn for replay\n');
    return respond();
  }

  try {
    const facts = await classifyTurn(userMessage);
    markProcessed(messageHash);

    if (!facts.length) return respond();

    // Hand the classified facts to the DAEMON (the sole DB owner) to resolve the
    // active session/project pods and save via AUDM. Routing through the daemon
    // is what fixes the embedded single-process PGlite conflict — this per-turn
    // hook process never opens the DB itself.
    const { connectOrStartDaemon } = await import('../clients/auto-spawn.js');
    let client;
    try {
      client = await connectOrStartDaemon({ quiet: true, timeoutMs: SAVE_TIMEOUT_MS });
      await client.call('ingestTurn', {
        facts,
        sessionId: input.session_id,
        cwd: input.cwd || null,
        transcriptPath: input.transcript_path || null,
      });
      resetBreaker(); // reached the daemon — clear any breaker a prior hook set
    } finally {
      if (client) await client.close().catch(() => {});
    }
  } catch (err) {
    // An alive-but-wedged daemon trips the breaker so the next turns spool fast
    // instead of each re-paying the save timeout against a stuck daemon.
    if (err?.name === 'SigilDaemonBusyError') tripBreaker();
    // Never block Claude — but the content was memorable and we couldn't save it
    // (daemon down / save failed / timed out). Spool the raw turn for replay once
    // the system recovers, and log so sigil doctor can surface it. A timeout that
    // the daemon nonetheless completes is harmless: AUDM dedups the replay.
    markProcessed(messageHash);
    appendSpool({
      message: userMessage,
      sessionId: input.session_id,
      cwd: input.cwd || null,
      transcriptPath: input.transcript_path || null,
      reason: maskSecrets(err.message || 'save-failed'),
    });
    process.stderr.write(`[sigil:stop] ${maskSecrets(err.message)}\n`);
    try {
      const { recordHookError } = await import('./error-log.js');
      await recordHookError('stop', err, input);
    } catch { /* ignore */ }
  }

  return respond();
}

function respond() {
  // Stop hook: empty JSON response is fine — we never want to block stop
  process.stdout.write('{}');
}

// ─── Find the last user message from whatever Claude Code sends ──────────

async function extractLastUserMessage(input) {
  // Other agents: the prompt hook saved this turn's prompt. Their transcripts
  // aren't in Claude Code's format (Codex documents its path as unstable).
  if (AGENT !== DEFAULT_AGENT) return takePrompt(AGENT, input.session_id);

  // Path 1: transcript file (Claude Code's standard Stop hook input shape)
  if (input.transcript_path && existsSync(input.transcript_path)) {
    const msg = readLastUserMessageFromTranscript(input.transcript_path);
    if (msg) return msg;
  }

  // Path 2: explicit messages array
  if (Array.isArray(input.messages)) {
    for (let i = input.messages.length - 1; i >= 0; i--) {
      const m = input.messages[i];
      if ((m.role === 'user' || m.message?.role === 'user') && m.content) {
        return contentToText(m.content);
      }
    }
  }

  // Path 3: direct fields some hosts use
  if (typeof input.last_user_message === 'string') return input.last_user_message;
  if (typeof input.user_message === 'string') return input.user_message;
  if (typeof input.prompt === 'string') return input.prompt;

  return null;
}

function readLastUserMessageFromTranscript(path) {
  let lines;
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }

    // Claude Code transcript entries typically have shape:
    //   { type: "user", message: { role: "user", content: "..." } }
    // or { role: "user", content: "..." }
    const role = entry.role || entry.message?.role || entry.type;
    if (role !== 'user') continue;

    const content = entry.content ?? entry.message?.content;
    const text = contentToText(content);
    // Skip tool_result entries that masquerade as user messages
    if (text && !looksLikeToolResult(text)) return text;
  }
  return null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function looksLikeToolResult(text) {
  // Heuristic — Claude Code wraps tool outputs with these prefixes
  return /^<tool_use_result|^<bash_output|^<file_contents|^Tool execution result/.test(text);
}

// ─── Cursor — skip already-processed messages ────────────────────────────

function alreadyProcessed(hash) {
  if (!existsSync(CURSOR_PATH)) return false;
  try {
    const cursor = JSON.parse(readFileSync(CURSOR_PATH, 'utf8'));
    return cursor.lastHash === hash;
  } catch {
    return false;
  }
}

function markProcessed(hash) {
  try {
    mkdirSync(dirname(CURSOR_PATH), { recursive: true });
    writeFileSync(CURSOR_PATH, JSON.stringify({ lastHash: hash, ts: Date.now() }), 'utf8');
  } catch { /* best effort */ }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

main();
