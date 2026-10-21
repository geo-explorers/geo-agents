#!/usr/bin/env node
// sync-skills — vendor the library's skills at one release tag.
//
//   node tools/sync-skills.mjs --ref v1.0.0 --dry-run     show what would change
//   node tools/sync-skills.mjs --ref v1.0.0               copy the skills, rewrite the lock
//   node tools/sync-skills.mjs --ref v1.0.0 --commit <40-hex>
//                                                         also require the tag to be this commit
//
// What it does:
//   1. Resolves the tag to its commit on the official library repository.
//   2. Fetches the library at exactly that tag into a temporary folder.
//   3. Copies every skill folder (skills/<tier>/<skill>/) byte for byte into
//      .claude/skills/<skill>/, replacing whatever was vendored before.
//   4. Writes skills.lock.json: the tag, the commit, and a sha256 per file.
//   5. Re-reads everything it wrote and checks it against the new lock.
//   6. Updates the two release lines in README.md (skill count and tag).
//
// Who runs it: the sync-skills-release workflow when geo-skills publishes a
// release, or a maintainer on purpose. Both end in a pull request, so the real
// skill diff is visible. An agent never runs it, and nothing here runs at agent start.
//
// It accepts release tags only (vX.Y.Z), never a branch, and only the official
// repository. No dependencies beyond Node 22+ and git.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LIBRARY_REPO, LIBRARY_URL, LOCK_FILE, REPO_ROOT, VENDOR_DIR,
  emptyLock, readLock, sha256File, verifyLock, walk,
} from './lib/lock.mjs';
import { updateReadmeStatus } from './lib/readme.mjs';

/** Rewrite README.md's release lines. Warns, never fails, if the lines are missing. */
function syncReadme({ skillCount, tag, write }) {
  const path = join(REPO_ROOT, 'README.md');
  if (!existsSync(path)) { console.warn('README.md not found; release lines not updated.'); return; }
  const result = updateReadmeStatus(readFileSync(path, 'utf8'), { skillCount, tag });
  if (!result.found.status || !result.found.count) {
    console.warn('README.md: could not find the status line or the skill-count sentence; update them by hand.');
  }
  if (!result.changed) return;
  if (write) writeFileSync(path, result.text);
  console.log(`${write ? 'Updated' : 'Would update'} README.md: ${skillCount} skills, ${tag}.`);
}

const TAG_RE = /^v\d+\.\d+\.\d+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** Thrown instead of exiting, so the temporary checkout is always cleaned up. */
class SyncError extends Error {}

function fail(message) {
  throw new SyncError(message);
}

function parseArgs(argv) {
  const args = { ref: null, commit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ref') args.ref = argv[++i] ?? null;
    else if (a === '--commit') args.commit = argv[++i] ?? null;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else fail(`unknown argument "${a}". Usage: node tools/sync-skills.mjs --ref vX.Y.Z [--commit <40-hex>] [--dry-run]`);
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

/** The commit a release tag points at, read from the official repository. */
function resolveTag(tag) {
  let out;
  try {
    out = git(['ls-remote', '--tags', LIBRARY_URL, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  } catch (err) {
    fail(`could not reach ${LIBRARY_URL}.\n${String(err.stderr || err.message).trim()}`);
  }
  const refs = new Map(out.split('\n').filter(Boolean).map((line) => {
    const [sha, name] = line.split(/\s+/);
    return [name, sha];
  }));
  // An annotated tag has its own object; "^{}" is the commit it points at.
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (!commit) fail(`tag ${tag} does not exist on ${LIBRARY_REPO}. Only release tags can be vendored, never a branch.`);
  return commit;
}

/** version: from a SKILL.md frontmatter block, or null. */
function skillVersion(skillMdPath) {
  const text = readFileSync(skillMdPath, 'utf8');
  if (!text.startsWith('---')) return null;
  const frontmatter = text.split('---', 3)[1] ?? '';
  for (const line of frontmatter.split('\n')) {
    const m = line.trim().match(/^version:\s*["']?([^"'\s]+)["']?/);
    if (m) return m[1];
  }
  return null;
}

/** Every skills/<tier>/<skill>/ folder that holds a SKILL.md. */
function discoverSkills(checkout) {
  const skillsDir = join(checkout, 'skills');
  if (!existsSync(skillsDir)) fail('the library checkout has no skills/ folder.');
  const found = new Map();
  for (const tier of readdirSync(skillsDir).sort()) {
    const tierDir = join(skillsDir, tier);
    if (!statSync(tierDir).isDirectory()) continue;
    for (const name of readdirSync(tierDir).sort()) {
      const dir = join(tierDir, name);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, 'SKILL.md'))) continue;
      if (found.has(name)) fail(`two skills are both named "${name}" (${found.get(name).tier} and ${tier}); they would collide in ${VENDOR_DIR}/.`);
      found.set(name, { tier, dir, version: skillVersion(join(dir, 'SKILL.md')) });
    }
  }
  if (found.size === 0) fail('no skills found in the library checkout.');
  return found;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/sync-skills.mjs --ref vX.Y.Z [--commit <40-hex>] [--dry-run]');
    return;
  }
  if (!args.ref) fail('missing --ref. Usage: node tools/sync-skills.mjs --ref vX.Y.Z [--commit <40-hex>] [--dry-run]');
  if (!TAG_RE.test(args.ref)) fail(`"${args.ref}" is not a release tag. Use the form vX.Y.Z, for example v1.0.0.`);
  if (args.commit && !COMMIT_RE.test(args.commit)) fail('--commit must be a full 40-character commit hash.');

  const previous = existsSync(join(REPO_ROOT, LOCK_FILE)) ? readLock() : emptyLock();

  // 1. Tag -> commit, with the two checks that catch a moved tag.
  const commit = resolveTag(args.ref);
  if (args.commit && args.commit !== commit) {
    fail(`${args.ref} points at ${commit}, not the expected ${args.commit}. Stop: the tag is not the release you reviewed.`);
  }
  if (previous.library?.tag === args.ref && previous.library?.commit && previous.library.commit !== commit) {
    fail(`${args.ref} was vendored at ${previous.library.commit} but now points at ${commit}. A published tag has moved. Stop and ask the library maintainers.`);
  }

  // 2. Fetch the library at exactly that tag. No line-ending conversion.
  const checkout = mkdtempSync(join(tmpdir(), 'geo-skills-'));
  try {
    try {
      git(['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', args.ref, LIBRARY_URL, checkout]);
    } catch (err) {
      fail(`could not fetch ${LIBRARY_REPO} at ${args.ref}.\n${String(err.stderr || err.message).trim()}`);
    }
    const fetched = git(['-C', checkout, 'rev-parse', 'HEAD']);
    if (fetched !== commit) fail(`fetched commit ${fetched} is not the tag's commit ${commit}.`);

    // 3. Plan: every file of every skill, with its fingerprint.
    const skills = discoverSkills(checkout);
    const plan = []; // { from, to }
    const files = {};
    const skillIndex = {};
    for (const [name, info] of skills) {
      const { files: relFiles, links } = walk(info.dir);
      if (links.length) fail(`skill ${name} contains a symbolic link (${links[0]}); refusing to vendor it.`);
      skillIndex[name] = { tier: info.tier, version: info.version };
      for (const rel of relFiles) {
        const to = `${VENDOR_DIR}/${name}/${rel}`;
        files[to] = sha256File(join(info.dir, rel));
        plan.push({ from: join(info.dir, rel), to });
      }
    }

    // Summary against what is vendored now.
    const before = previous.files ?? {};
    const added = Object.keys(files).filter((p) => !(p in before));
    const removed = Object.keys(before).filter((p) => !(p in files));
    const changed = Object.keys(files).filter((p) => p in before && before[p] !== files[p]);
    const from = previous.library?.tag ? `${previous.library.tag} @ ${previous.library.commit}` : 'nothing';
    console.log(`Library:  ${LIBRARY_REPO}`);
    console.log(`From:     ${from}`);
    console.log(`To:       ${args.ref} @ ${commit}`);
    console.log(`Skills:   ${skills.size}   Files: ${plan.length}   (added ${added.length}, changed ${changed.length}, removed ${removed.length})\n`);
    for (const [name, info] of skills) {
      const was = previous.skills?.[name]?.version;
      const note = was === undefined ? 'new' : was === info.version ? 'same version' : `was ${was}`;
      console.log(`  ${name.padEnd(28)} ${String(info.version ?? '?').padEnd(8)} ${info.tier.padEnd(15)} ${note}`);
    }
    for (const name of Object.keys(previous.skills ?? {})) {
      if (!skills.has(name)) console.log(`  ${name.padEnd(28)} ${'-'.padEnd(8)} ${'-'.padEnd(15)} REMOVED upstream`);
    }

    if (args.dryRun) {
      syncReadme({ skillCount: skills.size, tag: args.ref, write: false });
      console.log('\nDry run: nothing was written.');
      return;
    }
    if (added.length + changed.length + removed.length === 0 && previous.library?.commit === commit) {
      const check = verifyLock();
      if (check.ok) {
        console.log(`\nAlready at ${args.ref}; the vendored files match the lock. Nothing to do.`);
        return;
      }
      console.log('\nThe lock is current but the files on disk are not; restoring them.');
    }

    // 4. Replace the vendored folders, then write the lock.
    const vendorRoot = join(REPO_ROOT, VENDOR_DIR);
    for (const name of new Set([...Object.keys(previous.skills ?? {}), ...skills.keys()])) {
      rmSync(join(vendorRoot, name), { recursive: true, force: true });
    }
    for (const { from: src, to } of plan) {
      const dest = join(REPO_ROOT, to);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
    const lock = {
      library: { repo: LIBRARY_REPO, tag: args.ref, commit },
      vendoredAt: new Date().toISOString().slice(0, 10),
      skills: Object.fromEntries(Object.entries(skillIndex).sort(([a], [b]) => a.localeCompare(b))),
      files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    };
    writeFileSync(join(REPO_ROOT, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
    syncReadme({ skillCount: skills.size, tag: args.ref, write: true });

    // 5. Prove what is on disk is what the lock says.
    const check = verifyLock();
    if (!check.ok) {
      for (const p of check.problems) console.error(`  ${p.kind}  ${p.path}  ${p.detail}`);
      fail('the files just written do not match the new lock. Do not commit this.');
    }
    console.log(`\nVendored ${plan.length} file(s) into ${VENDOR_DIR}/ and rewrote ${LOCK_FILE}.`);
    console.log('Next: review the diff, then open a pull request. Do not edit the vendored files.');
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  if (!(err instanceof SyncError)) throw err;
  console.error(`sync-skills: ${err.message}`);
  process.exit(1);
}
