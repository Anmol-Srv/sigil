#!/usr/bin/env node
// Print the version CI should release next. Reads the base from package.json and
// the already-released versions from npm and the repo's v* tags.
// Usage: node scripts/release-version.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { nextReleaseVersion } from '../src/lib/release-version.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function lines(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/[\n,"[\]\s]+/).filter(Boolean);
  } catch {
    return [];
  }
}

const released = [
  ...lines('npm', ['view', pkg.name, 'versions', '--json']),
  ...lines('git', ['tag', '--list', 'v*']),
];
console.log(nextReleaseVersion(pkg.version, released));
