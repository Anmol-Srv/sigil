import { spawn } from 'node:child_process';

import config from '../../../config.js';
import { estimateTokens } from '../log.js';

const CLI_MODEL_MAP = {
  'claude-haiku-4-5-20251001': 'haiku',
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-6': 'opus',
};

const PERMISSIVE_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: true,
});

function spawnClaude(args, input) {
  const timeout = config.llm.cliTimeout || 120_000;

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${timeout}ms`));
    }, timeout);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

async function chat(input, { model, jsonMode = false } = {}) {
  const resolved = model || config.llm.cliModel || 'haiku';
  const cliModel = CLI_MODEL_MAP[resolved] || resolved;
  const args = ['-p', '--model', cliModel, '--output-format', 'json'];

  if (jsonMode) args.push('--json-schema', PERMISSIVE_SCHEMA);

  const { stdout, stderr, code } = await spawnClaude(args, input);

  if (code !== 0) {
    throw new Error(`claude CLI exited ${code}: ${(stderr || stdout).slice(0, 500)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Fallback: if JSON parsing fails, treat stdout as raw text
    return {
      text: stdout.trim(),
      inputTokens: estimateTokens(input),
      outputTokens: estimateTokens(stdout),
      model: cliModel,
    };
  }

  if (parsed.is_error) {
    throw new Error(`claude CLI error: ${parsed.result || 'unknown error'}`);
  }

  // When --json-schema is used, structured output is in a separate field
  const text = jsonMode && parsed.structured_output
    ? JSON.stringify(parsed.structured_output)
    : (parsed.result || '').trim();

  const usage = parsed.usage || {};

  return {
    text,
    inputTokens: usage.input_tokens || estimateTokens(input),
    outputTokens: usage.output_tokens || estimateTokens(text),
    model: cliModel,
    cost: parsed.total_cost_usd || 0,
  };
}

export { chat };
