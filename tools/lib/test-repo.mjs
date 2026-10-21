// Test helper: throwaway geo-agents checkouts with an isolated git, for the
// updater and session-check tests. Never touches the real checkout.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, VENDOR_DIR, sha256File, walk } from './lock.mjs';

/** A temp folder with its own git config, so no signing, hooks or user settings leak in. */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'geo-agents-test-'));
  const gitconfig = join(dir, 'gitconfig');
  writeFileSync(gitconfig, '[user]\n\tname = Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n');
  const env = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitconfig,
    GEO_AGENTS_ALLOW_ANY_ORIGIN: '1',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function sh(env, cwd, cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', input });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function git(env, cwd, ...args) {
  const r = sh(env, cwd, 'git', args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.err}`);
  return r.out.trim();
}

export function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** Rewrite skills.lock.json from what is on disk under .claude/skills. */
export function writeLock(root, tag) {
  const files = {};
  const skills = {};
  for (const f of walk(join(root, VENDOR_DIR)).files) {
    files[`${VENDOR_DIR}/${f}`] = sha256File(join(root, VENDOR_DIR, f));
    skills[f.split('/')[0]] = { tier: 'stable', version: '0.1.0' };
  }
  const lock = { library: { repo: 'geo-explorers/geo-skills', tag, commit: 'a'.repeat(40) }, vendoredAt: '2026-01-01T00:00:00.000Z', skills, files };
  writeFileSync(join(root, 'skills.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * remote.git (bare), seed (the "team"), editor (a clone at v1.0.0).
 * The seed carries a copy of this repo's tools/ and .claude/hooks/ so the scripts
 * resolve their root to the temp checkout.
 */
export function makeFixture() {
  const box = sandbox();
  const remote = join(box.dir, 'remote.git');
  const seed = join(box.dir, 'seed');
  const editor = join(box.dir, 'editor');
  git(box.env, box.dir, 'init', '--quiet', '--bare', remote);
  git(box.env, box.dir, 'init', '--quiet', seed);
  cpSync(join(REPO_ROOT, 'tools'), join(seed, 'tools'), { recursive: true });
  cpSync(join(REPO_ROOT, '.claude', 'hooks'), join(seed, '.claude', 'hooks'), { recursive: true });
  cpSync(join(REPO_ROOT, '.gitignore'), join(seed, '.gitignore'));
  write(seed, 'runs/.gitkeep', '');
  write(seed, 'README.md', '# geo-agents\n\nIntro.\n');
  write(seed, 'notes.md', 'team notes\n');
  write(seed, `${VENDOR_DIR}/demo/SKILL.md`, '---\nname: demo\n---\nv1\n');
  write(seed, `${VENDOR_DIR}/other/SKILL.md`, '---\nname: other\n---\nsame\n');
  writeLock(seed, 'v1.0.0');
  git(box.env, seed, 'add', '-A');
  git(box.env, seed, 'commit', '--quiet', '-m', 'v1.0.0');
  git(box.env, seed, 'remote', 'add', 'origin', remote);
  git(box.env, seed, 'push', '--quiet', 'origin', 'main');
  git(box.env, box.dir, 'clone', '--quiet', remote, editor);

  /** The team releases: the demo skill changes, plus any extra files. */
  const release = (tag, extra = {}) => {
    write(seed, `${VENDOR_DIR}/demo/SKILL.md`, `---\nname: demo\n---\n${tag}\n`);
    for (const [rel, text] of Object.entries(extra)) write(seed, rel, text);
    writeLock(seed, tag);
    git(box.env, seed, 'add', '-A');
    git(box.env, seed, 'commit', '--quiet', '-m', tag);
    git(box.env, seed, 'push', '--quiet', 'origin', 'main');
  };

  const run = (script, args = [], opts = {}) => sh(box.env, editor, 'node', [join(editor, script), ...args], opts);
  const update = (...args) => {
    const r = run('tools/update.mjs', args);
    let json = null;
    try { json = JSON.parse(r.out); } catch { /* reported below */ }
    if (!json) throw new Error(`update.mjs printed no JSON (exit ${r.code}): ${r.out}\n${r.err}`);
    return { code: r.code, ...json };
  };
  const g = (...args) => git(box.env, editor, ...args);
  return { ...box, remote, seed, editor, release, run, update, git: g };
}
