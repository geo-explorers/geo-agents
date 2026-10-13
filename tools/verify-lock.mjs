#!/usr/bin/env node
// verify-lock — prove the vendored skills are exactly what skills.lock.json records.
//
//   node tools/verify-lock.mjs
//
// Exit 0: every vendored file matches its fingerprint and nothing extra is present.
// Exit 1: at least one file was changed, added or removed. Do not run an agent;
//         ask a maintainer. Never "fix" a mismatch by editing the lock or the files.
//
// Read-only. It never downloads anything and never writes. Run it at the start of
// every agent session; CI runs it on every pull request.

import { verifyLock, LOCK_FILE, VENDOR_DIR } from './lib/lock.mjs';

const result = verifyLock();
const lib = result.lock?.library;
const source = lib?.tag ? `${lib.repo} ${lib.tag} @ ${lib.commit}` : 'nothing vendored yet';

if (result.ok) {
  console.log(`OK  ${result.checked} vendored file(s) match ${LOCK_FILE} (${source}).`);
  process.exit(0);
}

console.error(`FAILED  ${VENDOR_DIR}/ does not match ${LOCK_FILE} (${source}).\n`);
for (const p of result.problems) {
  console.error(`  ${p.kind.padEnd(8)}  ${p.path}\n            ${p.detail}`);
}
console.error(
  `\n${result.problems.length} problem(s). Vendored skills are never edited by hand.\n` +
    'Stop here and ask a maintainer. To restore the pinned release, a maintainer runs:\n' +
    `  node tools/sync-skills.mjs --ref ${lib?.tag ?? '<tag>'}`,
);
process.exit(1);
