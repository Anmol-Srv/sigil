import { copyFile, writeFile, rename, unlink, access } from 'node:fs/promises';

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

  // Atomic replace: write a same-dir temp file, then rename over the target.
  // On failure, clean up the temp so we never leave litter behind.
  const tmpPath = `${path}.sigil.tmp.${process.pid}`;
  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, path);
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
