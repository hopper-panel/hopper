// Moves every version in the repository at once, and tags the result.
//
//   node scripts/release.mjs 0.2.0
//
// Seven package.json files and two TypeScript constants have to agree, and the
// git tag has to agree with them. The administration compares the constant
// against the latest published release, so a build claiming a version it is not
// tells an operator they are up to date when they are not — which is the one
// failure the update check exists to prevent.
//
// Editing them by hand is how they drift, so nothing here is optional.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MANIFESTS = [
  'package.json',
  'apps/panel/package.json',
  'apps/panel/web/package.json',
  'apps/daemon/package.json',
  'packages/shared/package.json',
  'packages/templates/package.json',
  'packages/config/package.json',
];

const CONSTANTS = [
  ['apps/panel/src/version.ts', 'PANEL_VERSION'],
  ['apps/daemon/src/version.ts', 'DAEMON_VERSION'],
];

const version = process.argv[2];

// Semver, and nothing else. The check compares these strings, and a version it
// cannot order is a version it cannot compare.
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/release.mjs <version>   e.g. 0.2.0 or 1.0.0-rc.1');
  process.exit(1);
}

// A release built from a dirty tree is a release nobody can reproduce: the tag
// points at a commit that does not contain what was published.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

if (dirty.trim() !== '') {
  console.error('The working tree has uncommitted changes. Commit or stash them first.');
  process.exit(1);
}

for (const file of MANIFESTS) {
  const path = join(root, file);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

for (const [file, constant] of CONSTANTS) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  const next = source.replace(
    new RegExp(`export const ${constant} = '[^']*';`),
    `export const ${constant} = '${version}';`,
  );

  if (next === source) {
    console.error(`Could not find ${constant} in ${file}. Aborting rather than tagging a lie.`);
    process.exit(1);
  }

  writeFileSync(path, next, 'utf8');
}

console.log(`Set ${MANIFESTS.length} manifests and ${CONSTANTS.length} constants to ${version}.`);
console.log('');
console.log('Next:');
console.log(`  git commit -am "release: v${version}"`);
console.log(`  git tag -a v${version} -m "v${version}"`);
console.log(`  git push origin main --follow-tags`);
console.log('');
console.log('Then publish a release for that tag on GitHub: the panel compares its');
console.log('version against the latest *published release*, not against the tag list.');
