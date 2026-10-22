#!/usr/bin/env node
// Turn a downloaded copy of geo-agents (a ZIP from GitHub, no git) into a copy
// that updates itself: a git clone in a new folder next to this one.
//
// Claude runs this only after the editor said yes to the offer from the session
// check (see CLAUDE.md, "A downloaded copy can't update itself"). No GitHub account
// is needed: the repository is public.
//   1. Clones geo-agents into a new folder beside this one: geo-agents, or
//      geo-agents-2, -3 … if that name is taken.
//   2. Checks the new folder's vendored skills against its lock.
// Nothing in this folder is changed, moved or deleted.
//
// Usage: node tools/setup-clone.mjs
// Prints one JSON object: { status, message, ... }.
// Exit 0: cloned. Exit 2: stopped, nothing changed (needs-git, already-a-clone,
// clone-failed). Exit 1: unexpected error.

import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { REPO_ROOT, verifyLock } from './lib/lock.mjs';
import { checkoutKind, gitQuiet } from './lib/preflight.mjs';

/** Tests clone from a local folder instead of GitHub. */
const CLONE_URL = process.env.GEO_AGENTS_CLONE_URL ?? 'https://github.com/geo-explorers/geo-agents.git';

function finish(result, code) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(code);
}

function freeFolder(parent) {
  for (let i = 1; ; i++) {
    const path = join(parent, i === 1 ? 'geo-agents' : `geo-agents-${i}`);
    if (!existsSync(path)) return path;
  }
}

try {
  const kind = checkoutKind(REPO_ROOT);
  if (kind === 'clone') {
    finish({ status: 'stopped', reason: 'already-a-clone', message: 'This folder is already a git clone, so it updates itself. Nothing was changed.' }, 2);
  }

  const parent = dirname(REPO_ROOT);
  const target = freeFolder(parent);
  const r = gitQuiet(parent, ['clone', '--quiet', CLONE_URL, target], { timeoutMs: 300000 });
  if (r.missing || /xcrun|developer tools|command line tools/i.test(r.err)) {
    rmSync(target, { recursive: true, force: true });
    finish({
      status: 'stopped', reason: 'needs-git',
      message: 'This Mac needs git first. macOS shows a window offering to install the developer tools: click Install, wait until it finishes, then ask me again. If no window appeared, run `xcode-select --install` in Terminal. Nothing was changed.',
    }, 2);
  }
  if (r.code !== 0) {
    rmSync(target, { recursive: true, force: true });
    finish({
      status: 'stopped', reason: 'clone-failed',
      message: `The download from GitHub did not work (${r.timedOut ? 'it took too long' : r.err.split('\n').pop() || 'git failed'}). Check the internet connection and try again. Nothing was changed.`,
    }, 2);
  }

  const lock = verifyLock(target);
  const tag = lock.lock?.library?.tag ?? null;
  finish({
    status: 'cloned',
    path: target,
    tag,
    lockOk: lock.ok,
    message: [
      `Made a copy that updates itself, with the latest skills${tag ? ` (${tag})` : ''}: the folder "${basename(target)}" next to this one.`,
      'Open that folder in Claude Code and start a new session there. This folder was not changed; delete it whenever you like.',
      lock.ok ? '' : `Warning: the skills check in the new folder reports ${lock.problems.length} problem(s).`,
    ].filter(Boolean).join(' '),
  }, 0);
} catch (err) {
  finish({ status: 'error', message: err.message }, 1);
}
