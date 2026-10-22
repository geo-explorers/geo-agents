#!/usr/bin/env node
// SessionStart hook: tells Claude whether this checkout's skills are current.
// Registered in .claude/settings.json. Never blocks a session: always exits 0.
//
// Input (stdin, JSON): { source: "startup" | "resume" | ... }
// Output (stdout, JSON): { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }

import { readFileSync } from 'node:fs';
import { REPO_ROOT, verifyLock } from '../../tools/lib/lock.mjs';
import {
  checkoutKind, clearMarker, compareLocks, fetchOriginMain, fetchRemoteLock, readLockAt, readLockFile, readMarker,
  sessionContext,
} from '../../tools/lib/preflight.mjs';

function emit(text) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
  process.exit(0);
}

try {
  let source = 'startup';
  try {
    const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (typeof input.source === 'string') source = input.source;
  } catch { /* no or bad input: treat as a fresh start */ }

  // A brand-new session has the current skills loaded, so a pending restart is done.
  if (source === 'startup') clearMarker(REPO_ROOT);
  const marker = readMarker(REPO_ROOT);

  const lock = verifyLock(REPO_ROOT);
  const kind = checkoutKind(REPO_ROOT);
  let remote;
  if (kind === 'clone') {
    const fetched = fetchOriginMain(REPO_ROOT, { timeoutMs: 8000 });
    remote = fetched.ok ? { ok: true, lock: readLockAt(REPO_ROOT, 'refs/remotes/origin/main') } : fetched;
  } else {
    // A downloaded copy has no git, but the repository is public: read the team's lock over HTTPS.
    remote = await fetchRemoteLock({ timeoutMs: 8000 });
  }
  const cmp = remote.ok ? compareLocks(readLockFile(REPO_ROOT), remote.lock) : { status: 'unknown', reason: remote.error };

  emit(sessionContext({ source, cmp, lock, marker, kind, fetchError: remote.ok ? null : remote.error }));
} catch (err) {
  emit(`geo-agents session check could not run (${err.message}). Mention this in one line and carry on.`);
}
