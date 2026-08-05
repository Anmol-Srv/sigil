/**
 * Multi-signal client detection.
 *
 * A config directory is not evidence that a client is installed: Sigil itself
 * creates some of those directories when it connects an agent, and they can
 * outlive the app. Only a real app bundle or executable may opt a client into
 * installer defaults. Callers may still explicitly select any supported
 * client.
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

const HOME = homedir();

/** macOS: is any of these app bundles installed (system or user Applications)? */
export function appInstalled(appNames = []) {
  if (platform() !== 'darwin') return false;
  const roots = ['/Applications', join(HOME, 'Applications')];
  return appNames.some((n) => roots.some((r) => existsSync(join(r, `${n}.app`))));
}

/** Is a CLI binary present in a common install dir? (PATH-independent.) */
export function binInstalled(binNames = []) {
  const knownDirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    join(HOME, '.local', 'bin'),
    join(HOME, '.bun', 'bin'),
    join(HOME, '.cargo', 'bin'),
  ];
  // Version managers deliberately install binaries outside the conventional
  // locations above (for example ~/.nvm/.../bin/claude). The active terminal
  // can execute them, so doctor and client discovery must recognise them too.
  // Only absolute PATH entries are considered: a project-relative directory
  // must not make a repository file look like a machine-wide installed client.
  const pathDirs = (process.env.PATH || '')
    .split(delimiter)
    .filter((dir) => isAbsolute(dir));
  const dirs = [...new Set([...knownDirs, ...pathDirs])];
  const exts = platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return binNames.some((b) => dirs.some((d) => exts.some((e) => existsSync(join(d, b + e)))));
}

/** OR across real app bundles and CLI binaries; `dirs` is deliberately ignored. */
export function detectInstalled({ apps = [], bins = [] } = {}, {
  checkApp = appInstalled,
  checkBin = binInstalled,
} = {}) {
  return checkApp(apps) || checkBin(bins);
}
