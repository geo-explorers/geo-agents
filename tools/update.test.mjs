// Tests for tools/update.mjs and the session check, against throwaway repos.
// Run: node --test tools/update.test.mjs

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { VENDOR_DIR } from './lib/lock.mjs';
import { MARKER_FILE } from './lib/preflight.mjs';
import { makeFixture, write } from './lib/test-repo.mjs';

let fx;
afterEach(() => fx?.cleanup());

const read = (rel) => readFileSync(join(fx.editor, rel), 'utf8');
const head = () => fx.git('rev-parse', 'HEAD');
const origin = () => fx.git('rev-parse', 'origin/main');
const status = () => fx.git('status', '--porcelain=v1', '--untracked-files=all');

function sessionCheck(source = 'startup') {
  const r = fx.run('.claude/hooks/session-start.mjs', [], { input: JSON.stringify({ source }) });
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out).hookSpecificOutput.additionalContext;
}

test('clean checkout fast-forwards and asks for a restart', () => {
  fx = makeFixture();
  fx.release('v1.1.0');
  const r = fx.update();
  assert.equal(r.code, 0);
  assert.equal(r.status, 'updated');
  assert.equal(r.from, 'v1.0.0');
  assert.equal(r.to, 'v1.1.0');
  assert.equal(r.lockOk, true);
  assert.equal(r.restartRequired, true);
  assert.equal(head(), origin());
  assert.match(read(`${VENDOR_DIR}/demo/SKILL.md`), /v1\.1\.0/);
  assert.deepEqual(JSON.parse(read(MARKER_FILE)).to, 'v1.1.0');
});

test('loose untracked files are left byte-for-byte as they were', () => {
  fx = makeFixture();
  fx.release('v1.1.0');
  write(fx.editor, 'my-draft.md', 'draft ü\n');
  write(fx.editor, 'scratch/data.csv', 'a,b\n1,2\n');
  const r = fx.update();
  assert.equal(r.status, 'updated');
  assert.equal(read('my-draft.md'), 'draft ü\n');
  assert.equal(read('scratch/data.csv'), 'a,b\n1,2\n');
});

test('a tracked edit is stashed and put back', () => {
  fx = makeFixture();
  fx.release('v1.1.0');
  write(fx.editor, 'notes.md', 'team notes\nmy line\n');
  const r = fx.update();
  assert.equal(r.status, 'updated');
  assert.equal(r.stash.state, 'restored');
  assert.equal(read('notes.md'), 'team notes\nmy line\n');
  assert.equal(fx.git('stash', 'list'), '');
});

test('a stale branch: ends on main, the old branch keeps its commit', () => {
  fx = makeFixture();
  fx.git('switch', '--quiet', '-c', 'old-work');
  write(fx.editor, 'mine.md', 'committed\n');
  fx.git('add', 'mine.md');
  fx.git('commit', '--quiet', '-m', 'my commit');
  const oldTip = head();
  write(fx.editor, 'notes.md', 'team notes\nedit on old branch\n');
  fx.release('v1.1.0');
  const r = fx.update();
  assert.equal(r.status, 'updated');
  assert.equal(fx.git('branch', '--show-current'), 'main');
  assert.equal(head(), origin());
  assert.equal(fx.git('rev-parse', 'old-work'), oldTip);
  assert.equal(r.previousBranch, 'old-work');
  assert.equal(r.previousBranchOwnCommits, 1);
  assert.equal(read('notes.md'), 'team notes\nedit on old branch\n');
  assert.equal(existsSync(join(fx.editor, 'mine.md')), false);
});

test('edited and extra vendored files are backed up and the released files restored', () => {
  fx = makeFixture();
  fx.release('v1.1.0');
  write(fx.editor, `${VENDOR_DIR}/other/SKILL.md`, 'hand edit\n');
  write(fx.editor, `${VENDOR_DIR}/other/extra.txt`, 'extra\n');
  const r = fx.update();
  assert.equal(r.status, 'updated');
  assert.equal(r.lockOk, true);
  assert.ok(r.backupDir);
  assert.deepEqual([...r.restoredVendored].sort(), [`${VENDOR_DIR}/other/SKILL.md`, `${VENDOR_DIR}/other/extra.txt`]);
  assert.equal(readFileSync(join(fx.editor, r.backupDir, VENDOR_DIR, 'other/SKILL.md'), 'utf8'), 'hand edit\n');
  assert.equal(readFileSync(join(fx.editor, r.backupDir, VENDOR_DIR, 'other/extra.txt'), 'utf8'), 'extra\n');
  assert.equal(status(), '');
});

test('a diverged main stops and changes nothing', () => {
  fx = makeFixture();
  write(fx.editor, 'mine.md', 'x\n');
  fx.git('add', 'mine.md');
  fx.git('commit', '--quiet', '-m', 'local only');
  fx.release('v1.1.0');
  const before = head();
  const r = fx.update();
  assert.equal(r.code, 2);
  assert.equal(r.status, 'stopped');
  assert.equal(r.reason, 'diverged');
  assert.equal(head(), before);
  assert.equal(existsSync(join(fx.editor, MARKER_FILE)), false);
});

test('an edit to a file the update also changes stays in the stash', () => {
  fx = makeFixture();
  fx.release('v1.1.0', { 'README.md': '# geo-agents\n\nIntro, updated.\n' });
  write(fx.editor, 'README.md', '# geo-agents\n\nIntro, mine.\n');
  const r = fx.update();
  assert.equal(r.status, 'updated');
  assert.equal(r.stash.state, 'kept');
  assert.deepEqual(r.stash.overlap, ['README.md']);
  assert.equal(read('README.md'), '# geo-agents\n\nIntro, updated.\n');
  assert.match(fx.git('stash', 'list'), /geo-agents update/);
  assert.equal(head(), origin());
});

test('an untracked file where the update brings a file stops and changes nothing', () => {
  fx = makeFixture();
  fx.release('v1.1.0', { 'new-doc.md': 'from the team\n' });
  write(fx.editor, 'new-doc.md', 'mine\n');
  const before = head();
  const r = fx.update();
  assert.equal(r.code, 2);
  assert.equal(r.reason, 'untracked-would-be-overwritten');
  assert.deepEqual(r.files, ['new-doc.md']);
  assert.equal(head(), before);
  assert.equal(read('new-doc.md'), 'mine\n');
});

test('--dry-run reports the plan and changes nothing', () => {
  fx = makeFixture();
  fx.release('v1.1.0');
  write(fx.editor, 'notes.md', 'edited\n');
  const before = head();
  const r = fx.update('--dry-run');
  assert.equal(r.code, 0);
  assert.equal(r.status, 'planned');
  assert.deepEqual(r.stash, ['notes.md']);
  assert.equal(head(), before);
  assert.equal(read('notes.md'), 'edited\n');
  assert.equal(fx.git('stash', 'list'), '');
});

test('already current: nothing to do', () => {
  fx = makeFixture();
  const r = fx.update();
  assert.equal(r.status, 'already-current');
  assert.equal(existsSync(join(fx.editor, MARKER_FILE)), false);
});

test('session check: behind offers the update; unreachable remote says it could not check', () => {
  fx = makeFixture();
  assert.match(sessionCheck(), /Skills are up to date \(v1\.0\.0\)/);
  fx.release('v1.1.0');
  const text = sessionCheck();
  assert.match(text, /SKILLS UPDATE AVAILABLE/);
  assert.match(text, /v1\.0\.0 → v1\.1\.0/);
  assert.match(text, /demo 0\.1\.0 → 0\.1\.0/);
  assert.match(text, /node tools\/update\.mjs/);
  fx.git('remote', 'set-url', 'origin', join(fx.dir, 'missing.git'));
  assert.match(sessionCheck(), /Couldn't check for newer skills/);
});

test('session check after an update: resume keeps the block, startup clears it', () => {
  fx = makeFixture();
  fx.release('v1.1.0');
  assert.equal(fx.update().status, 'updated');
  assert.match(sessionCheck('resume'), /blocked until the editor starts a NEW Claude Code session/);
  assert.equal(existsSync(join(fx.editor, MARKER_FILE)), true);
  assert.match(sessionCheck('startup'), /Skills are up to date \(v1\.1\.0\)/);
  assert.equal(existsSync(join(fx.editor, MARKER_FILE)), false);
});
