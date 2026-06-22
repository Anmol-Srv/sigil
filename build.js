#!/usr/bin/env node

import { build } from 'esbuild';
import { rm, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

// Dep classification rule:
//   - dependencies      → packages listed in EXTERNAL below. Resolved at runtime
//                         from the user's node_modules. Anything with native code,
//                         WASM, or version-sensitive runtime behavior belongs here.
//   - devDependencies   → everything else imported by src/. Bundled into dist/ at
//                         publish time, so end users never install them. Adding a
//                         new import? Decide: bundle (devDep) or external (dep).
//   - optionalDeps      → SDKs only loaded by some providers (e.g. @anthropic-ai/sdk).
//
// Packages we keep external — either binary (WASM), dynamically loaded, or large SDKs
const EXTERNAL = [
  'knex',                      // dynamic migration loading
  'pg',                        // native bindings
  '@electric-sql/pglite',      // embedded engine — WASM, dynamically imported
  '@electric-sql/pglite/vector',
  '@electric-sql/pglite/contrib/pg_trgm',
  '@anthropic-ai/sdk',         // dynamic import, heavy
  '@modelcontextprotocol/sdk', // MCP protocol
  '@modelcontextprotocol/sdk/server/mcp.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
  'dotenv',                    // light, better to externalize for config flexibility
  'ws',                        // WebSocket — bufferutil/utf-8-validate optional natives
  '@number0/iroh',             // Iroh NAPI binding — prebuilt native, must be external
];

const ENTRIES = [
  { in: 'src/cli.js', out: 'cli.js', shebang: true },
  { in: 'src/server.js', out: 'server.js', shebang: true },
  { in: 'src/daemon/index.js', out: 'daemon.js', shebang: true },
  { in: 'src/hooks/user-prompt-submit.js', out: 'hooks/user-prompt-submit.js', shebang: true },
  { in: 'src/hooks/post-tool-use.js', out: 'hooks/post-tool-use.js', shebang: true },
  { in: 'src/hooks/stop.js', out: 'hooks/stop.js', shebang: true },
  { in: 'src/hooks/session-end.js', out: 'hooks/session-end.js', shebang: true },
  // Managed-session worker MCP server — spawned by a warm worker via
  // --mcp-config, so it must exist as a standalone runnable entry in dist/.
  { in: 'src/mcp/worker-server.js', out: 'mcp/worker-server.js', shebang: true },
];

async function run() {
  // Clean dist
  if (existsSync(DIST)) await rm(DIST, { recursive: true });
  await mkdir(DIST, { recursive: true });
  await mkdir(join(DIST, 'hooks'), { recursive: true });
  await mkdir(join(DIST, 'mcp'), { recursive: true });

  console.log('Building Sigil bundles...\n');

  for (const entry of ENTRIES) {
    const outfile = join(DIST, entry.out);

    await build({
      entryPoints: [entry.in],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      minify: true,
      sourcemap: false,
      external: EXTERNAL,
      logLevel: 'warning',
      legalComments: 'none',
      // ESM output can't synchronously `require()` a bundled CJS dep's
      // `require("stream")` etc. — esbuild emits a shim that throws
      // unless we hand it a real `require` via createRequire. (Surfaced
      // by `sigil doctor` on a fresh install — see PR #9 review.)
      banner: {
        js: "import { createRequire as __sigilCreateRequire } from 'node:module'; const require = __sigilCreateRequire(import.meta.url);",
      },
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
