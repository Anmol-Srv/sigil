#!/usr/bin/env node

import { build } from 'esbuild';
import { rm, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

// Packages we keep external — either binary (WASM), dynamically loaded, or large SDKs
const EXTERNAL = [
  '@electric-sql/pglite',     // has WASM binary
  '@electric-sql/pglite/vector',
  'knex',                      // dynamic migration loading
  'pg',                        // native bindings
  '@anthropic-ai/sdk',         // dynamic import, heavy
  '@modelcontextprotocol/sdk', // MCP protocol
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  'dotenv',                    // light, better to externalize for config flexibility
];

const ENTRIES = [
  { in: 'src/cli.js', out: 'cli.js', shebang: true },
  { in: 'src/server.js', out: 'server.js', shebang: true },
  { in: 'src/hooks/user-prompt-submit.js', out: 'hooks/user-prompt-submit.js', shebang: true },
  { in: 'src/hooks/post-tool-use.js', out: 'hooks/post-tool-use.js', shebang: true },
];

async function run() {
  // Clean dist
  if (existsSync(DIST)) await rm(DIST, { recursive: true });
  await mkdir(DIST, { recursive: true });
  await mkdir(join(DIST, 'hooks'), { recursive: true });

  console.log('Building Cortex bundles...\n');

  for (const entry of ENTRIES) {
    const outfile = join(DIST, entry.out);

    await build({
      entryPoints: [entry.in],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node18',
      format: 'esm',
      minify: true,
      sourcemap: false,
      external: EXTERNAL,
      logLevel: 'warning',
      legalComments: 'none',
    });

    // Normalize shebang: ensure exactly one at the very top
    if (entry.shebang) {
      let content = await readFile(outfile, 'utf8');
      content = content.replace(/^(#!.*\n)+/, '');
      await writeFile(outfile, '#!/usr/bin/env node\n' + content);
      await chmod(outfile, 0o755);
    }

    const size = (await readFile(outfile)).length;
    const kb = (size / 1024).toFixed(1);
    console.log(`  ${outfile.padEnd(45)} ${kb.padStart(7)} KB`);
  }

  console.log('\nBundle complete. dist/ ready for publishing.');
}

run().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
