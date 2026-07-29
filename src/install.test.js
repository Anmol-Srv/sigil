import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = readFileSync(resolve(process.cwd(), 'install.sh'), 'utf8');

describe('official installer contract', () => {
  it('uses a lockfile install and hands off to the shared first-run flow', () => {
    expect(installer).toContain('npm ci --omit=dev');
    expect(installer).toContain('exec node "$CLI" < /dev/tty');
    expect(installer).toContain('node $CLI init');
  });

  it('preserves local install edits before resetting the release clone', () => {
    expect(installer).toContain('git -C "$APP_DIR" stash push --include-untracked');
    expect(installer).toContain('git -C $APP_DIR stash pop');
    expect(installer.indexOf('stash push --include-untracked')).toBeLessThan(
      installer.indexOf('reset --hard --quiet FETCH_HEAD'),
    );
  });

  it('never provisions the retired managed coding-agent runtime', () => {
    expect(installer).not.toMatch(/tmux|managed-session|SIGIL_MANAGED_SESSION/i);
  });
});
