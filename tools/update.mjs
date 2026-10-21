#!/usr/bin/env node
// Bring this checkout up to the team's main, safely, for an editor.
//
// Claude runs this only after the editor said yes to the update offer from the
// session check (see CLAUDE.md, "Updating this checkout"). It never deletes work:
//   1. Edited or extra files in the vendored skills are copied to
//      runs/update-backup-<time>/ and the released files are put back.
//   2. Other edits to tracked files are stashed. Untracked files are left alone.
//   3. The checkout switches to main (other branches are never touched) and
//      fast-forwards to origin/main.
//   4. The stash is put back, unless it touches a file the update changed: then
//      it stays in the stash and Claude works through it with the editor.
//   5. A restart marker makes the restart guard block skill work until a new session.
//
// Usage:
//   node tools/update.mjs             # update (asks permission: see .claude/settings.json)
//   node tools/update.mjs --dry-run   # checks only, changes nothing
//
// Prints one JSON object: { status, message, ... }.
// Exit 0: updated, already-current or planned. Exit 2: stopped, nothing changed.
// Exit 1: unexpected error.

import { copyFileSync, existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCK_FILE, REPO_ROOT, VENDOR_DIR, verifyLock } from './lib/lock.mjs';
import { fetchOriginMain, gitQuiet, readLockAt, writeMarker } from './lib/preflight.mjs';

const ROOT = REPO_ROOT;
const DRY_RUN = process.argv.includes('--dry-run');
const VENDORED = [VENDOR_DIR, LOCK_FILE];

class Stop extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.reason = reason;
    this.extra = extra;
  }
}

function finish(result, code) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

function git(args) {
  const r = gitQuiet(ROOT, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err || `exit ${r.code}`}`);
  return r.out;
}
const gitOk = (args) => gitQuiet(ROOT, args).code === 0;
const nulList = (out) => out.split('\0').filter(Boolean);

/** Paths from `git status --porcelain=v1 -z`; a rename contributes both names. */
function statusPaths(args) {
  const parts = nulList(git(['status', '--porcelain=v1', '-z', ...args]));
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    out.push(parts[i].slice(3));
    if (code[0] === 'R' || code[0] === 'C') out.push(parts[++i]);
  }
  return out;
}

function inProgress() {
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const p = git(['rev-parse', '--git-path', name]).trim();
    if (existsSync(join(ROOT, p)) || existsSync(p)) return name;
  }
  return null;
}

function backup(dir, rel, { move }) {
  const src = join(ROOT, rel);
  if (!existsSync(src) && !isLink(src)) return false;
  const dst = join(ROOT, dir, rel);
  mkdirSync(dirname(dst), { recursive: true });
  if (move) renameSync(src, dst);
  else copyFileSync(src, dst);
  return true;
}
function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function run() {
  // ---------- checks: nothing changes until all of these pass ----------
  if (!gitOk(['rev-parse', '--is-inside-work-tree'])) throw new Stop('not-a-checkout', 'This folder is not a git checkout.');

  const busy = inProgress();
  if (busy) throw new Stop('operation-in-progress', `A git ${busy.replace(/_HEAD$|-.*$/, '').toLowerCase()} is in progress. It has to be finished or abandoned first.`, { operation: busy });
  const unmerged = nulList(git(['diff', '--name-only', '-z', '--diff-filter=U']));
  if (unmerged.length) throw new Stop('conflicts-unresolved', 'Some files still have unresolved conflicts.', { files: unmerged });

  const branchRes = gitQuiet(ROOT, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branchRes.code !== 0) throw new Stop('detached-head', 'The checkout is not on a branch (detached HEAD).');
  const branch = branchRes.out.trim();
  const startHead = git(['rev-parse', 'HEAD']).trim();

  const fetched = fetchOriginMain(ROOT, { timeoutMs: 30000 });
  if (!fetched.ok) throw new Stop('fetch-failed', `Couldn't download the team's main: ${fetched.error}.`);
  const target = git(['rev-parse', 'refs/remotes/origin/main']).trim();

  const hasMain = gitOk(['rev-parse', '--verify', '--quiet', 'refs/heads/main']);
  if (hasMain && !gitOk(['merge-base', '--is-ancestor', 'refs/heads/main', target])) {
    const ahead = git(['rev-list', '--count', `${target}..refs/heads/main`]).trim();
    throw new Stop('diverged', `Local main has ${ahead} commit(s) that are not on the team's main, so it can't simply move forward.`, { localOnlyCommits: Number(ahead) });
  }

  const fromLock = readLockAt(ROOT, 'HEAD');
  const toLock = readLockAt(ROOT, target);
  const from = fromLock?.library?.tag ?? null;
  const to = toLock?.library?.tag ?? null;

  const vendoredDirty = statusPaths(['--untracked-files=no', '--', ...VENDORED]);
  const vendoredExtra = nulList(git(['ls-files', '-z', '--others', '--', VENDOR_DIR]));
  const onTarget = branch === 'main' && startHead === target;
  if (onTarget && vendoredDirty.length === 0 && vendoredExtra.length === 0 && verifyLock(ROOT).ok) {
    return { code: 0, result: { status: 'already-current', message: `Already up to date (${to ?? 'no release recorded'}).`, from, to } };
  }

  const incoming = new Set(nulList(git(['ls-tree', '-r', '-z', '--name-only', target])));
  const untracked = nulList(git(['ls-files', '-z', '--others', '--exclude-standard']));
  const collide = untracked.filter((p) => incoming.has(p) && !p.startsWith(`${VENDOR_DIR}/`));
  if (collide.length) {
    throw new Stop('untracked-would-be-overwritten',
      'Some of your own files (not tracked by git) sit where the update brings in a file of the same name.', { files: collide });
  }

  const otherDirty = statusPaths(['--untracked-files=no']).filter((p) => !VENDORED.some((v) => p === v || p.startsWith(`${v}/`)));
  const plan = {
    from, to, branch, switchToMain: branch !== 'main',
    restoreVendored: [...new Set([...vendoredDirty, ...vendoredExtra])],
    stash: otherDirty,
    keptUntracked: untracked.length - vendoredExtra.filter((p) => untracked.includes(p)).length,
  };
  if (DRY_RUN) return { code: 0, result: { status: 'planned', message: 'Checks passed. Nothing was changed (dry run).', ...plan } };

  // ---------- actions ----------
  const backupDir = `runs/update-backup-${stamp()}`;
  const restoredVendored = [];
  let stashSha = null;
  let switched = false;

  const rollback = () => {
    if (switched) gitQuiet(ROOT, ['switch', '--quiet', branch]);
    if (stashSha) gitQuiet(ROOT, ['stash', 'pop', '--quiet']);
  };

  // 1. Vendored skills back to released state, keeping a copy of anything changed.
  if (plan.restoreVendored.length) {
    for (const p of vendoredDirty) if (backup(backupDir, p, { move: false })) restoredVendored.push(p);
    git(['reset', '--quiet', '--', ...VENDORED]);
    git(['checkout', '--', ...VENDORED]);
    for (const p of nulList(git(['ls-files', '-z', '--others', '--', VENDOR_DIR]))) {
      if (backup(backupDir, p, { move: true })) restoredVendored.push(p);
    }
  }

  try {
    // 2. Stash the editor's other tracked edits. Untracked files stay where they are.
    if (statusPaths(['--untracked-files=no']).length) {
      git(['stash', 'push', '--quiet', '-m', `geo-agents update ${stamp()}`]);
      stashSha = git(['rev-parse', 'refs/stash']).trim();
    }

    // 3. Onto main.
    if (branch !== 'main') {
      git(hasMain ? ['switch', '--quiet', 'main'] : ['switch', '--quiet', '-c', 'main', '--track', 'origin/main']);
      switched = true;
    }
    git(['merge', '--ff-only', '--quiet', target]);
  } catch (err) {
    rollback();
    throw new Stop('update-failed', `The update could not be applied, so the checkout was put back as it was: ${err.message}`,
      restoredVendored.length ? { restoredVendored, backupDir } : {});
  }

  const moved = startHead !== target || restoredVendored.length > 0;
  if (moved) writeMarker(ROOT, { updatedAt: new Date().toISOString(), from, to });

  // 4. Put the stash back only if it can't clash with what the update changed.
  let stash = { state: 'none' };
  if (stashSha) {
    const theirs = new Set(nulList(git(['diff', '--name-only', '-z', startHead, target])));
    const mine = [...new Set([
      ...nulList(git(['diff', '--name-only', '-z', `${stashSha}^1`, stashSha])),
      ...nulList(git(['diff', '--name-only', '-z', `${stashSha}^1`, `${stashSha}^2`])),
    ])];
    const overlap = mine.filter((p) => theirs.has(p));
    if (overlap.length === 0 && gitOk(['stash', 'pop', '--quiet'])) stash = { state: 'restored', files: mine };
    else stash = { state: 'kept', ref: stashSha, files: mine, overlap };
  }

  const ahead = branch !== 'main' ? Number(git(['rev-list', '--count', `${target}..${branch}`]).trim()) : 0;
  const lock = verifyLock(ROOT);

  const notes = [startHead === target ? 'Skill files were put back to the released version.' : `Updated to ${to ?? 'the latest main'}${from && from !== to ? ` (was ${from})` : ''}.`];
  if (restoredVendored.length) notes.push(`${restoredVendored.length} changed or extra skill file(s) were copied to ${backupDir}.`);
  if (stash.state === 'restored') notes.push('Your edits were put back.');
  if (stash.state === 'kept') notes.push(`Your edits to ${stash.overlap.join(', ') || 'some files'} touch files the update changed, so they are kept safe in the git stash for now.`);
  if (branch !== 'main') notes.push(`Switched from branch "${branch}" to main; "${branch}" is untouched${ahead ? ` and still has ${ahead} commit(s) of its own` : ''}.`);
  if (!lock.ok) notes.push(`Warning: the skills check still reports ${lock.problems.length} problem(s).`);
  if (moved) notes.push('Start a new Claude Code session to load the new skills.');

  return {
    code: 0,
    result: {
      status: 'updated', message: notes.join(' '), from, to,
      previousBranch: branch, previousBranchOwnCommits: ahead,
      restoredVendored, backupDir: restoredVendored.length ? backupDir : null,
      stash, lockOk: lock.ok, lockProblems: lock.problems.slice(0, 20), restartRequired: moved,
    },
  };
}

try {
  const { code, result } = run();
  finish(result, code);
} catch (err) {
  if (err instanceof Stop) finish({ status: 'stopped', reason: err.reason, message: `${err.message} Nothing else was changed.`, ...err.extra }, 2);
  finish({ status: 'error', message: err.message }, 1);
}
