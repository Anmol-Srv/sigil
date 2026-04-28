#!/usr/bin/env node

/**
 * UserPromptSubmit hook — injects relevant Cortex facts into Claude's context.
 *
 * Reads the user's prompt from stdin (JSON from Claude Code),
 * searches Cortex for matching facts, and returns them as additionalContext.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';

import { maskSecrets } from './secret-mask.js';

// Load env before anything else
const home = process.env.HOME || process.env.USERPROFILE;
const globalEnv = join(home, '.cortex', '.env');
const localEnv = resolve(process.cwd(), '.env');
if (existsSync(localEnv)) dotenvConfig({ path: localEnv, quiet: true });
else if (existsSync(globalEnv)) dotenvConfig({ path: globalEnv, quiet: true });

const MIN_QUERY_LENGTH = 8;
const MAX_FACTS = 8;

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return respond();

  const input = JSON.parse(raw);
  const query = input.prompt || '';

  // Skip short/trivial prompts
  if (query.length < MIN_QUERY_LENGTH) return respond();

  try {
    const { search } = await import('../memory/search/hybrid.js');
    const config = (await import('../config.js')).default;

    const { facts } = await search(query, {
      namespaces: [config.defaults.namespace],
      limit: MAX_FACTS,
      useGraph: false,
      route: false,
      expand: false,
    });

    if (!facts.length) {
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.destroy();
      return respond();
    }

    const context = maskSecrets([
      `Cortex memory (${facts.length} relevant facts):`,
      ...facts.map((f) => `- ${f.content}`),
    ].join('\n'));

    const cortexDb = (await import('../db/cortex.js')).default;
    await cortexDb.destroy();
    return respond(context);
  } catch (err) {
    // Never block Claude — fail silently
    process.stderr.write(`[cortex:user-prompt-submit] ${err.message}\n`);
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
