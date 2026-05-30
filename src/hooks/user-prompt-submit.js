#!/usr/bin/env node

/**
 * UserPromptSubmit hook — injects relevant Sigil facts into Claude's context.
 *
 * Reads the user's prompt from stdin (JSON from Claude Code), searches
 * Sigil with the prompt as query, and returns the top facts as
 * additionalContext for Claude.
 *
 * 0.10.0:
 *   • route + expand turned ON — the query router (which existed but was
 *     bypassed) now classifies the query and adjusts search params
 *     (categories, limit, useGraph, expand variants).
 *   • podScope='auto' — search is now scoped to active session + project
 *     + person pods via the registry, falling back to global for queries
 *     that the active scope doesn't cover.
 *   • Token budget — INJECTION_BUDGET_CHARS caps the total injected
 *     payload at ~1200 tokens (4 chars/token approx), preferred over the
 *     old fixed MAX_FACTS so retrieval-rich queries get more facts and
 *     long-fact queries don't blow the budget.
 *   • synthesize stays OFF here — synthesis adds 1-3s + an LLM call to
 *     every user message and steals the citation surface from Claude.
 *     Phase 2 will revisit if router signal warrants it.
 */

import { maskSecrets } from './secret-mask.js';
import { recordHookError, failClosedOnBadConfig } from './error-log.js';
import { loadHookEnv } from './env-loader.js';

loadHookEnv();

const MIN_QUERY_LENGTH = 8;
const MAX_FACTS = 20;
const INJECTION_BUDGET_CHARS = 4800; // ~1200 tokens

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return respond();

  const input = JSON.parse(raw);
  const query = input.prompt || '';

  // Skip short/trivial prompts
  if (query.length < MIN_QUERY_LENGTH) return respond();

  // Config gate — bail before any LLM/embedding call if config is
  // known-broken. Saves the doomed API call and writes a specific
  // error (with fix instructions) to .hook-errors.log instead of the
  // generic "404 model not found" the upstream produces.
  if (await failClosedOnBadConfig('user-prompt-submit', raw)) return respond();

  try {
    const { search } = await import('../memory/search/hybrid.js');
    const config = (await import('../config.js')).default;

    // Project-scoped, precision-first. We deliberately do NOT fall back to a
    // global search on empty/error — that fallback was the cross-project leak
    // (a gstack/sigil prompt pulling unrelated payment-webhook facts). The
    // floor (applyFloor defaults true in search()) drops off-topic matches,
    // and resolvePodScope's SIGIL_SCOPE_GRACE path already returns floored
    // global ONLY for genuine fresh installs with zero pods. Empty beats wrong.
    let result;
    try {
      result = await search(query, {
        namespaces: [config.defaults.namespace],
        limit: MAX_FACTS,
        useGraph: false, // router promotes to true when warranted
        route: true,
        expand: true,
        synthesize: false,
        podScope: 'auto',
        ctx: {
          cwd: input.cwd || null,
          sessionId: input.session_id || null,
        },
      });
    } catch (searchErr) {
      // A failed scoped search injects NOTHING (never the global brain). Log
      // for `sigil doctor`; the prompt proceeds without memory.
      process.stderr.write(`[sigil:user-prompt-submit] scoped search failed: ${searchErr.message}\n`);
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.destroy().catch(() => {});
      return respond();
    }

    const facts = result?.facts || [];

    if (!facts.length) {
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.destroy();
      return respond();
    }

    // Apply token budget — take facts in score order until the cumulative
    // char count would exceed budget. Always take at least one fact even
    // if it's over budget alone (better than no signal).
    const chosen = [];
    let used = 0;
    for (const f of facts) {
      const len = (f.content || '').length + 4; // "- " prefix + newline
      if (chosen.length > 0 && used + len > INJECTION_BUDGET_CHARS) break;
      chosen.push(f);
      used += len;
    }

    const context = maskSecrets([
      `Sigil memory (${chosen.length} relevant facts):`,
      ...chosen.map((f) => `- ${f.content}`),
    ].join('\n'));

    const cortexDb = (await import('../db/cortex.js')).default;
    await cortexDb.destroy();
    return respond(context);
  } catch (err) {
    // Never block Claude — fail silently, but log so sigil doctor can surface it
    process.stderr.write(`[sigil:user-prompt-submit] ${err.message}\n`);
    await recordHookError('user-prompt-submit', err, raw);
    try {
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.destroy();
    } catch { /* ignore */ }
    return respond();
  }
}

function respond(additionalContext) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      ...(additionalContext && { additionalContext }),
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main();
