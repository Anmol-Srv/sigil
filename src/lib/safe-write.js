import { copyFile, writeFile, rename, unlink, access, lstat, realpath, stat, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const BAK_SUFFIX = '.sigil.bak';

// Wraps fs.writeFile with three safety guarantees:
//  - ATOMIC: write to a sibling temp file, then rename() over the target. rename
//    is atomic on the same filesystem, so a crash / power-loss mid-write can never
//    leave a half-written (corrupt) config — the old file stays fully intact until
//    the new content is complete. The temp lives in the same dir so rename never
//    crosses a filesystem boundary (no EXDEV).
//  - BACKUP-ONCE: if `path` already exists and a .sigil.bak doesn't, copy the
//    original to .bak BEFORE writing — preserves the user's pre-sigil content so
//    they can restore by hand. The .bak is written exactly once per file: later
//    sigil runs see it exists and don't clobber the original snapshot.
//  - DRY-RUN: if dryRun is true, no filesystem write happens at all; the function
//    returns the planned action so callers can render a preview.
//
// Symlink + permission preservation: rename() replaces the inode, so a naive
// temp→rename would (a) detach a symlinked target — breaking chezmoi / Nix
// home-manager / stow-managed dotfiles — and (b) reset the file mode to the
// umask default, silently widening a 0600 config to 0644. We resolve a symlink
// to its real target and atomic-write THERE (link stays intact), and we carry
// the existing file's mode onto the temp before the rename.
export async function safeWrite(path, content, { dryRun = false } = {}) {
  const existed = await fileExists(path);
  const action = existed ? 'modify' : 'create';
  const bytes = Buffer.byteLength(content, 'utf8');

  if (dryRun) return { path, action, bytes, wrote: false, backedUp: false };

  let backedUp = false;
  if (existed) {
    const bakPath = `${path}${BAK_SUFFIX}`;
    if (!(await fileExists(bakPath))) {
      await copyFile(path, bakPath);
      backedUp = true;
    }
  }

  // If `path` is a symlink, write to the file it points at so rename() replaces
  // the real file and leaves the link in place. realpath also collapses any
  // intermediate link components, keeping the temp a true sibling of the target.
  let target = path;
  try {
    if ((await lstat(path)).isSymbolicLink()) target = await realpath(path);
  } catch { /* ENOENT — brand-new file, no link to follow */ }

  // Carry the existing file's permission bits so an atomic replace can't relax a
  // deliberately-tightened mode (e.g. 0600). Absent (new file) → umask default.
  let mode;
  try { mode = (await stat(target)).mode & 0o777; } catch { /* new file */ }

  // Atomic replace: write a same-dir temp file, then rename over the target.
  // The temp name is unique per call (pid + random) so two concurrent writes to
  // the same path can't clobber each other's temp. On failure, clean up the temp
  // so we never leave litter behind.
  const tmpPath = `${target}.sigil.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    await writeFile(tmpPath, content, 'utf8');
    if (mode !== undefined) await chmod(tmpPath, mode);
    await rename(tmpPath, target);
  } catch (err) {
    await unlink(tmpPath).catch(() => { /* temp may not exist */ });
    throw err;
  }

  return { path, action, bytes, wrote: true, backedUp };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
