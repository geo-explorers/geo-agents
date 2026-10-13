// Shared by sync-skills.mjs and verify-lock.mjs: where the vendored skills live,
// how a file is fingerprinted, and how the lock file is read and compared.
//
// No dependencies. Node 22+.

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root: two levels up from tools/lib/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The only library skills are ever vendored from. */
export const LIBRARY_REPO = 'geo-explorers/content-management';
export const LIBRARY_URL = `https://github.com/${LIBRARY_REPO}.git`;

/** Vendored skills live here, one folder per skill. Never hand-edited. */
export const VENDOR_DIR = '.claude/skills';
export const LOCK_FILE = 'skills.lock.json';

/** Files that are not part of any skill and are never fingerprinted. */
const IGNORED = new Set(['.DS_Store', '.gitkeep']);

/** sha256 of a file's exact bytes, as lowercase hex. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Every file under `dir`, as POSIX paths relative to `dir`, sorted.
 * A symbolic link is reported in `links` instead of being followed: a link
 * could point outside the vendored folder, so the callers refuse it.
 */
export function walk(dir) {
  const files = [];
  const links = [];
  const visit = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      if (IGNORED.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(childAbs);
      if (stat.isSymbolicLink()) links.push(childRel);
      else if (stat.isDirectory()) visit(childAbs, childRel);
      else if (stat.isFile()) files.push(childRel);
    }
  };
  if (existsSync(dir)) visit(dir, '');
  return { files, links };
}

/** An empty lock: nothing vendored yet. */
export function emptyLock() {
  return {
    library: { repo: LIBRARY_REPO, tag: null, commit: null },
    vendoredAt: null,
    skills: {},
    files: {},
  };
}

export function readLock(root = REPO_ROOT) {
  const path = join(root, LOCK_FILE);
  if (!existsSync(path)) throw new Error(`${LOCK_FILE} not found in ${root}`);
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  if (!lock || typeof lock !== 'object' || typeof lock.files !== 'object' || lock.files === null) {
    throw new Error(`${LOCK_FILE} has no "files" map`);
  }
  return lock;
}

/**
 * Compare the vendored folder on disk with the lock file.
 *
 * Returns { ok, checked, problems, lock }. `problems` is a list of
 * { kind, path, detail } where kind is one of:
 *   DRIFT     a listed file's bytes differ from the recorded fingerprint
 *   MISSING   a listed file is not on disk
 *   UNLISTED  a file is on disk in the vendored folder but not in the lock
 *   LINK      a symbolic link inside the vendored folder
 *   LOCK      the lock file itself is not usable
 */
export function verifyLock(root = REPO_ROOT) {
  const problems = [];
  let lock;
  try {
    lock = readLock(root);
  } catch (err) {
    return { ok: false, checked: 0, problems: [{ kind: 'LOCK', path: LOCK_FILE, detail: err.message }], lock: null };
  }

  const listed = Object.keys(lock.files).sort();
  const prefix = `${VENDOR_DIR}/`;

  for (const path of listed) {
    if (!path.startsWith(prefix) || path.split('/').includes('..')) {
      problems.push({ kind: 'LOCK', path, detail: `lock entry is outside ${VENDOR_DIR}/` });
    }
  }
  if (listed.length > 0 && !(lock.library && lock.library.tag && /^[0-9a-f]{40}$/.test(lock.library.commit ?? ''))) {
    problems.push({ kind: 'LOCK', path: LOCK_FILE, detail: 'files are listed but the library tag or 40-character commit is missing' });
  }

  const { files, links } = walk(join(root, VENDOR_DIR));
  const onDisk = new Set(files.map((f) => `${prefix}${f}`));

  for (const link of links) {
    problems.push({ kind: 'LINK', path: `${prefix}${link}`, detail: 'symbolic links are not allowed in vendored skills' });
  }
  for (const path of listed) {
    if (!path.startsWith(prefix)) continue;
    if (!onDisk.has(path)) {
      problems.push({ kind: 'MISSING', path, detail: 'listed in the lock, not on disk' });
      continue;
    }
    const actual = sha256File(join(root, path));
    if (actual !== lock.files[path]) {
      problems.push({ kind: 'DRIFT', path, detail: `expected ${String(lock.files[path]).slice(0, 12)}…, found ${actual.slice(0, 12)}…` });
    }
  }
  for (const path of [...onDisk].sort()) {
    if (!(path in lock.files)) {
      problems.push({ kind: 'UNLISTED', path, detail: 'on disk, not in the lock' });
    }
  }

  return { ok: problems.length === 0, checked: listed.length, problems, lock };
}
