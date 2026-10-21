// Helpers shared by the session-start check, the restart guard and the updater.
// No dependencies. Node 22+.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCK_FILE, VENDOR_DIR } from './lock.mjs';

/** Written by tools/update.mjs after it moved the checkout; cleared by a new session. */
export const MARKER_FILE = 'runs/.restart-required.json';

const OFFICIAL_ORIGIN = /github\.com[:/]geo-explorers\/geo-agents(\.git)?\/?$/i;

// ---------- versions ----------

export function parseTag(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag ?? ''));
  return m ? m.slice(1).map(Number) : null;
}

/** -1 if a < b, 0 if equal, 1 if a > b, null if either is not an exact vX.Y.Z tag. */
export function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// ---------- locks ----------

const prefix = `${VENDOR_DIR}/`;
const skillOfPath = (p) => (p.startsWith(prefix) ? p.slice(prefix.length).split('/')[0] : null);

function filesBySkill(lock) {
  const out = new Map();
  for (const [path, hash] of Object.entries(lock?.files ?? {})) {
    const name = skillOfPath(path);
    if (!name) continue;
    if (!out.has(name)) out.set(name, {});
    out.get(name)[path] = hash;
  }
  return out;
}

function sameMap(a = {}, b = {}) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[k] === a[k]);
}

/** Which skills changed, were added or were removed between two locks, by file fingerprints. */
export function diffSkills(local, remote) {
  const lf = filesBySkill(local);
  const rf = filesBySkill(remote);
  const version = (lock, name) => lock?.skills?.[name]?.version ?? null;
  const changed = [];
  const added = [];
  const removed = [];
  for (const name of [...new Set([...lf.keys(), ...rf.keys()])].sort()) {
    if (!lf.has(name)) added.push({ name, to: version(remote, name) });
    else if (!rf.has(name)) removed.push({ name, from: version(local, name) });
    else if (!sameMap(lf.get(name), rf.get(name))) changed.push({ name, from: version(local, name), to: version(remote, name) });
  }
  return { changed, added, removed };
}

/**
 * Compare this checkout's lock with the team's (origin/main).
 * status: current | behind | ahead | mismatch | unknown
 * "behind" needs a newer tag AND different files: a release with no skill change never prompts.
 */
export function compareLocks(local, remote) {
  const usable = (l) => l && typeof l === 'object' && l.files && typeof l.files === 'object';
  if (!usable(local) || !usable(remote)) return { status: 'unknown', reason: 'a skills lock is missing or unreadable' };
  const from = local.library?.tag ?? null;
  const to = remote.library?.tag ?? null;
  const skills = diffSkills(local, remote);
  if (sameMap(local.files, remote.files)) {
    const lockOnly = from !== to || (local.library?.commit ?? null) !== (remote.library?.commit ?? null);
    return { status: 'current', from, to, lockOnly, skills };
  }
  const c = compareTags(from, to);
  if (c === -1) return { status: 'behind', from, to, skills };
  if (c === 1) return { status: 'ahead', from, to, skills };
  return { status: 'mismatch', from, to, skills };
}

export function describeSkills({ changed = [], added = [], removed = [] } = {}) {
  const parts = [
    ...changed.map((s) => `${s.name} ${s.from ?? '?'} → ${s.to ?? '?'}`),
    ...added.map((s) => (s.to ? `${s.name} ${s.to} (new)` : `${s.name} (new)`)),
    ...removed.map((s) => `${s.name} (removed)`),
  ];
  return parts.join(', ');
}

// ---------- tools that count as skill work ----------

/** True for tool calls that use the skills or agents loaded into this session. */
export function isSkillWork(toolName, toolInput) {
  if (toolName === 'Skill' || toolName === 'Agent' || toolName === 'Task') return true;
  if (toolName === 'Bash') return /\.claude[\\/]+skills/.test(String(toolInput?.command ?? ''));
  return false;
}

// ---------- restart marker ----------

export function readMarker(root) {
  const path = join(root, MARKER_FILE);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function writeMarker(root, data) {
  const path = join(root, MARKER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function clearMarker(root) {
  rmSync(join(root, MARKER_FILE), { force: true });
}

// ---------- git ----------

/** git with no prompts of any kind: hooks and the updater must never hang on a password. */
export function gitQuiet(root, args, { timeoutMs } = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=5',
  };
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim(), timedOut: r.error?.code === 'ETIMEDOUT' || Boolean(r.signal) };
}

export function originUrl(root) {
  const r = gitQuiet(root, ['remote', 'get-url', 'origin']);
  return r.code === 0 ? r.out.trim() : null;
}

/** Tests point origin at a local folder; they set GEO_AGENTS_ALLOW_ANY_ORIGIN=1. */
export function isOfficialOrigin(url) {
  return OFFICIAL_ORIGIN.test(String(url ?? '')) || process.env.GEO_AGENTS_ALLOW_ANY_ORIGIN === '1';
}

/** Refresh origin/main only. Returns { ok } or { ok: false, error }. */
export function fetchOriginMain(root, { timeoutMs = 8000 } = {}) {
  const url = originUrl(root);
  if (!url) return { ok: false, error: 'this checkout has no origin remote' };
  if (!isOfficialOrigin(url)) return { ok: false, error: `origin is ${url}, not geo-explorers/geo-agents` };
  const r = gitQuiet(root, ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=5',
    'fetch', '--quiet', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeoutMs });
  if (r.timedOut) return { ok: false, error: 'GitHub did not answer in time' };
  if (r.code !== 0) return { ok: false, error: r.err.split('\n').pop() || 'git fetch failed' };
  return { ok: true };
}

export function readLockFile(root) {
  try { return JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8')); } catch { return null; }
}

export function readLockAt(root, ref) {
  const r = gitQuiet(root, ['show', `${ref}:${LOCK_FILE}`]);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

// ---------- what the session-start hook tells Claude ----------

export function sessionContext({ source = 'startup', cmp, lock, marker, fetchError }) {
  const lines = ['geo-agents session check (from .claude/hooks/session-start.mjs):'];
  const resume = source !== 'startup';

  if (marker) {
    lines.push(
      `Skills in this checkout were updated during this conversation (${marker.from ?? '?'} → ${marker.to ?? '?'}), and this session still has the old skills and rules loaded. ` +
      'Skill and agent work stays blocked until the editor starts a NEW Claude Code session (a fresh one, not a resumed one). If they ask for skill work, tell them that in one sentence.',
    );
    return lines.join('\n');
  }

  const lockBad = lock && !lock.ok;
  if (lockBad) lines.push(`The vendored skills do not match skills.lock.json (${lock.problems.length} problem(s)).`);

  const askUpdate = (why) => {
    lines.push(
      `${why} Before working on the editor's first request, ask them once, in plain words: ` +
      `"Newer skills are available (${cmp.from ?? '?'} → ${cmp.to ?? '?'}). Shall I update now? Your own files are kept; afterwards you start a new Claude Code session." ` +
      'If they say yes: run `node tools/update.mjs` and follow CLAUDE.md, section "Updating this checkout". ' +
      `If they say no: carry on with ${cmp.from ?? 'the current version'} and do not ask again in this session. ` +
      'Never update with your own git commands.',
    );
    if (resume) lines.push('If the editor already answered this earlier in this conversation, do not ask again.');
  };

  switch (cmp?.status) {
    case 'behind': {
      const what = describeSkills(cmp.skills);
      askUpdate(`SKILLS UPDATE AVAILABLE. This checkout has geo-skills ${cmp.from}; the team's main has ${cmp.to}${what ? ` (changed: ${what})` : ''}.` +
        (lockBad ? ' The update also puts the released skill files back.' : ''));
      break;
    }
    case 'mismatch':
      askUpdate(`This checkout's skills differ from the team's for the same release (${cmp.from}). The update puts the released files back.`);
      break;
    case 'ahead':
      lines.push(`This checkout has newer skills (${cmp.from}) than the team's main (${cmp.to}). Carry on; no update needed.`);
      break;
    case 'current':
      lines.push(cmp.lockOnly
        ? `Skills are up to date: the team's main records ${cmp.to} with identical skill files. No update needed.`
        : `Skills are up to date (${cmp.from}).`);
      break;
    default:
      lines.push(`Couldn't check for newer skills (${fetchError ?? cmp?.reason ?? 'unknown reason'}). Mention this in one line and carry on.`);
  }

  if (lockBad && !['behind', 'mismatch'].includes(cmp?.status)) {
    lines.push('Follow hard rule 2 in CLAUDE.md: stop and tell the editor that a maintainer must restore the vendored skills.');
  }
  return lines.join('\n');
}
