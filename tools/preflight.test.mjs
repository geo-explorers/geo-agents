// Tests for tools/lib/preflight.mjs and the restart guard.
// Run: node --test tools/preflight.test.mjs

import assert from 'node:assert/strict';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { REPO_ROOT } from './lib/lock.mjs';
import {
  MARKER_FILE, compareLocks, compareTags, isOfficialOrigin, isSkillWork, sessionContext, writeMarker,
} from './lib/preflight.mjs';
import { sandbox, sh } from './lib/test-repo.mjs';

const S = '.claude/skills';
const lock = (tag, files, skills = {}) => ({ library: { repo: 'geo-explorers/geo-skills', tag, commit: 'c'.repeat(40) }, skills, files });

test('compareTags orders numerically and rejects suffixed tags', () => {
  assert.equal(compareTags('v1.10.0', 'v1.9.9'), 1);
  assert.equal(compareTags('v1.2.0', 'v1.2.1'), -1);
  assert.equal(compareTags('v2.0.0', 'v2.0.0'), 0);
  assert.equal(compareTags('v1.2.0-test', 'v1.2.0'), null);
  assert.equal(compareTags(null, 'v1.0.0'), null);
});

test('compareLocks: every status', () => {
  const a = { [`${S}/x/SKILL.md`]: '1', [`${S}/y/SKILL.md`]: '2' };
  const b = { [`${S}/x/SKILL.md`]: '9', [`${S}/y/SKILL.md`]: '2', [`${S}/z/SKILL.md`]: '3' };
  const behind = compareLocks(lock('v1.0.0', a, { x: { version: '0.1.0' } }), lock('v1.1.0', b, { x: { version: '0.1.1' }, z: { version: '0.1.0' } }));
  assert.equal(behind.status, 'behind');
  assert.deepEqual(behind.skills.changed, [{ name: 'x', from: '0.1.0', to: '0.1.1' }]);
  assert.deepEqual(behind.skills.added, [{ name: 'z', to: '0.1.0' }]);
  assert.equal(compareLocks(lock('v1.1.0', b), lock('v1.0.0', a)).status, 'ahead');
  assert.equal(compareLocks(lock('v1.0.0', a), lock('v1.0.0', b)).status, 'mismatch');
  assert.equal(compareLocks(lock('v1.0.0', a), lock('v1.0.0', a)).status, 'current');
  assert.equal(compareLocks(null, lock('v1.0.0', a)).status, 'unknown');
  assert.equal(compareLocks(lock('v1.0.0', a), {}).status, 'unknown');
});

test('compareLocks: a newer release with identical skill files is not "behind"', () => {
  const f = { [`${S}/x/SKILL.md`]: '1' };
  const r = compareLocks(lock('v1.0.0', f), lock('v1.0.1', f));
  assert.equal(r.status, 'current');
  assert.equal(r.lockOnly, true);
});

test('sessionContext: what Claude is told for each status', () => {
  const ok = { ok: true, problems: [] };
  const behind = sessionContext({ cmp: { status: 'behind', from: 'v1.0.0', to: 'v1.1.0', skills: { changed: [{ name: 'x', from: '0.1.0', to: '0.1.1' }] } }, lock: ok });
  assert.match(behind, /SKILLS UPDATE AVAILABLE/);
  assert.match(behind, /x 0\.1\.0 → 0\.1\.1/);
  assert.match(behind, /node tools\/update\.mjs/);
  assert.match(behind, /do not ask again in this session/);
  assert.doesNotMatch(behind, /already answered/);
  assert.match(sessionContext({ source: 'resume', cmp: { status: 'behind', from: 'v1.0.0', to: 'v1.1.0' }, lock: ok }), /already answered/);
  assert.match(sessionContext({ cmp: { status: 'current', from: 'v1.0.0' }, lock: ok }), /up to date \(v1\.0\.0\)/);
  assert.match(sessionContext({ cmp: { status: 'ahead', from: 'v1.1.0', to: 'v1.0.0' }, lock: ok }), /newer skills/);
  assert.match(sessionContext({ cmp: { status: 'mismatch', from: 'v1.0.0' }, lock: ok }), /Shall I update now/);
  assert.match(sessionContext({ cmp: { status: 'unknown' }, fetchError: 'offline', lock: ok }), /Couldn't check.*offline/);
  const broken = { ok: false, problems: [{ kind: 'DRIFT' }] };
  assert.match(sessionContext({ cmp: { status: 'current', from: 'v1.0.0' }, lock: broken }), /hard rule 2/);
  assert.match(sessionContext({ cmp: { status: 'behind', from: 'v1.0.0', to: 'v1.1.0' }, lock: broken }), /puts the released skill files back/);
  const marked = sessionContext({ source: 'resume', cmp: { status: 'behind' }, lock: ok, marker: { from: 'v1.0.0', to: 'v1.1.0' } });
  assert.match(marked, /NEW Claude Code session/);
  assert.doesNotMatch(marked, /Shall I update/);
});

test('isSkillWork: skills, agents and vendored scripts only', () => {
  assert.equal(isSkillWork('Skill', { skill: 'geo-publish' }), true);
  assert.equal(isSkillWork('Agent', {}), true);
  assert.equal(isSkillWork('Task', {}), true);
  assert.equal(isSkillWork('Bash', { command: 'node .claude/skills/geo-query/scripts/q.mjs' }), true);
  assert.equal(isSkillWork('Bash', { command: 'node tools/verify-lock.mjs' }), false);
  assert.equal(isSkillWork('Bash', { command: 'git status' }), false);
  assert.equal(isSkillWork('Read', { file_path: '.claude/skills/x/SKILL.md' }), false);
  assert.equal(isSkillWork('mcp__hypergraph-mcp__search_entities', {}), false);
});

test('isOfficialOrigin accepts the team repo over https and ssh only', () => {
  const saved = process.env.GEO_AGENTS_ALLOW_ANY_ORIGIN;
  delete process.env.GEO_AGENTS_ALLOW_ANY_ORIGIN;
  try {
    assert.equal(isOfficialOrigin('https://github.com/geo-explorers/geo-agents.git'), true);
    assert.equal(isOfficialOrigin('git@github.com:geo-explorers/geo-agents.git'), true);
    assert.equal(isOfficialOrigin('https://github.com/someone/geo-agents.git'), false);
    assert.equal(isOfficialOrigin('/tmp/remote.git'), false);
  } finally {
    if (saved !== undefined) process.env.GEO_AGENTS_ALLOW_ANY_ORIGIN = saved;
  }
});

// ---------- the guard, run the way Claude Code runs it ----------

let box;
afterEach(() => box?.cleanup());

function guardRoot() {
  box = sandbox();
  const root = join(box.dir, 'checkout');
  cpSync(join(REPO_ROOT, 'tools', 'lib'), join(root, 'tools', 'lib'), { recursive: true });
  cpSync(join(REPO_ROOT, '.claude', 'hooks'), join(root, '.claude', 'hooks'), { recursive: true });
  return root;
}
const guard = (root, input) => sh(box.env, root, 'node', [join(root, '.claude/hooks/restart-guard.mjs')], { input });
const call = (tool_name, tool_input = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input });

test('restart guard: allows everything without a marker', () => {
  const root = guardRoot();
  assert.equal(guard(root, call('Skill', { skill: 'geo-publish' })).code, 0);
});

test('restart guard: with a marker, blocks skill work and allows the rest', () => {
  const root = guardRoot();
  writeMarker(root, { from: 'v1.0.0', to: 'v1.1.0' });
  const blocked = guard(root, call('Skill', { skill: 'geo-publish' }));
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /start a new Claude Code session/);
  assert.equal(guard(root, call('Agent', {})).code, 2);
  assert.equal(guard(root, call('Bash', { command: 'python3 .claude/skills/x/run.py' })).code, 2);
  assert.equal(guard(root, call('Bash', { command: 'ls' })).code, 0);
  assert.equal(guard(root, call('Read', { file_path: 'README.md' })).code, 0);
  assert.equal(guard(root, 'not json').code, 2);
});

test('session check: startup clears the marker, resume keeps it', () => {
  const root = guardRoot();
  const check = (source) => sh(box.env, root, 'node', [join(root, '.claude/hooks/session-start.mjs')], { input: JSON.stringify({ source }) });
  writeMarker(root, { from: 'v1.0.0', to: 'v1.1.0' });
  const resumed = check('resume');
  assert.equal(resumed.code, 0);
  assert.match(JSON.parse(resumed.out).hookSpecificOutput.additionalContext, /NEW Claude Code session/);
  assert.equal(existsSync(join(root, MARKER_FILE)), true);
  const started = check('startup');
  assert.equal(started.code, 0);
  assert.equal(JSON.parse(started.out).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(existsSync(join(root, MARKER_FILE)), false);
});
