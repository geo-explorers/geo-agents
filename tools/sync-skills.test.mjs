// Tests for the README lines that tools/sync-skills.mjs keeps in step with the lock.
// Run: node --test tools/sync-skills.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from './lib/lock.mjs';
import { updateReadmeStatus } from './lib/readme.mjs';

const README = [
  '# geo-agents',
  '',
  '> **Status.** 15 skills vendored from geo-skills `v1.2.1`. More text.',
  '',
  'All 15 library skills are vendored into `.claude/skills/`.',
  '',
].join('\n');

test('updates the tag and both counts', () => {
  const r = updateReadmeStatus(README, { skillCount: 16, tag: 'v1.3.0' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.found, { status: true, count: true });
  assert.match(r.text, /^> \*\*Status\.\*\* 16 skills vendored from geo-skills `v1\.3\.0`\. More text\.$/m);
  assert.match(r.text, /^All 16 library skills are vendored/m);
});

test('is idempotent', () => {
  const once = updateReadmeStatus(README, { skillCount: 16, tag: 'v1.3.0' }).text;
  const twice = updateReadmeStatus(once, { skillCount: 16, tag: 'v1.3.0' });
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

test('reports a missing line instead of failing', () => {
  const r = updateReadmeStatus('# no status here\n', { skillCount: 1, tag: 'v1.0.0' });
  assert.deepEqual(r.found, { status: false, count: false });
  assert.equal(r.changed, false);
});

test('the real README has both lines', () => {
  const r = updateReadmeStatus(readFileSync(join(REPO_ROOT, 'README.md'), 'utf8'), { skillCount: 15, tag: 'v1.2.1' });
  assert.deepEqual(r.found, { status: true, count: true });
});
