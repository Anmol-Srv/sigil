#!/usr/bin/env node

/**
 * PostToolUse hook — captures observations from Claude's tool usage.
 *
 * Runs after Edit/Write/Bash tool calls. Stores lightweight observations
 * directly as facts (skips full pipeline — no LLM calls, fast).
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';

// Load env before anything else
const home = process.env.HOME || process.env.USERPROFILE;
const globalEnv = join(home, '.cortex', '.env');
const localEnv = resolve(process.cwd(), '.env');
if (existsSync(localEnv)) dotenvConfig({ path: localEnv, quiet: true });
else if (existsSync(globalEnv)) dotenvConfig({ path: globalEnv, quiet: true });

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return respond();

  const input = JSON.parse(raw);
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const toolResponse = input.tool_response || '';

  const observation = summarize(toolName, toolInput, toolResponse);
  if (!observation) return respond();

  try {
    const { saveFact } = await import('../memory/facts/store.js');
    const { embed } = await import('../ingestion/embedder.js');
    const config = (await import('../config.js')).default;

    const embedding = await embed(observation);

    await saveFact({
      content: observation,
      category: 'observation',
      confidence: 'medium',
      importance: 'supplementary',
      namespace: config.defaults.namespace,
      sourceDocumentIds: [],
      sourceSection: 'session',
      embedding,
    });

    const cortexDb = (await import('../db/cortex.js')).default;
    await cortexDb.destroy();
  } catch (err) {
    process.stderr.write(`[cortex:post-tool-use] ${err.message}\n`);
    try {
      const cortexDb = (await import('../db/cortex.js')).default;
      await cortexDb.destroy();
    } catch { /* ignore */ }
  }

  return respond();
}

function summarize(toolName, toolInput, toolResponse) {
  if (toolName === 'Edit' || toolName === 'Write') {
    const file = toolInput.file_path || 'unknown file';
    const action = toolName === 'Write' ? 'Created' : 'Edited';
    return `${action} ${file}`;
  }

  if (toolName === 'Bash') {
    const cmd = (toolInput.command || '').slice(0, 200);
    if (!cmd) return null;
    // Skip noisy/read-only commands — only capture meaningful actions
    if (/^(ls|cat|head|tail|echo|pwd|cd|which|find|grep|rg|wc|file|stat|diff|man|cortex|npm test|npm run)\b/.test(cmd)) return null;
    return `Ran: ${cmd}`;
  }

  return null;
}

function respond() {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main();
