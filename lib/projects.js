// Whether a folder is one an app made for a single conversation.
//
// A session is filed under the folder it ran in. Codex's desktop app gives a
// conversation started without a project a folder of its own, under the
// person's Documents, named for the day and the first words typed:
//   ~/Documents/Codex/2026-03-09/can-you
// Listed as projects, such folders bury the real ones: one entry for every
// conversation. Whatever agent is later run in one is filed with it.
//
// Only that place counts. A folder that merely has such names above it,
// inside some repository, is a project like any other.
//
// The Claude desktop app has its own case, a Cowork session that was given
// no folder to work in. That is known from the app's record of the session
// rather than from a path, and is marked where sessions are found.

import os from 'node:os';

const parts = folder => folder.split(/[\\/]+/).filter(Boolean);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isConversationFolder(project, home = os.homedir()) {
  if (typeof project !== 'string' || typeof home !== 'string' || !home) return false;
  const base = parts(home);
  const folder = parts(project);
  // Windows spells a drive letter either way, and so do its folders.
  const same = (a, b) => a === b || (/^[A-Za-z]:$/.test(base[0] || '') && a.toLowerCase() === b.toLowerCase());
  if (folder.length <= base.length || !base.every((name, at) => same(name, folder[at]))) return false;
  let rest = folder.slice(base.length);
  // Windows can keep Documents inside a OneDrive folder.
  if (/^OneDrive/i.test(rest[0]) && same('Documents', rest[1] || '')) rest = rest.slice(1);
  return rest.length >= 4 && same('Documents', rest[0]) && same('Codex', rest[1]) && DAY.test(rest[2]);
}
