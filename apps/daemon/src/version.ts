/**
 * The version this build is.
 *
 * Written here and in every package.json, and matched by a git tag `v0.1.0`.
 * The three have to agree: the administration compares this string against the
 * latest published release, so a build claiming a version it is not tells an
 * operator they are up to date when they are not.
 *
 * `scripts/release.mjs` moves all of them together. Editing one by hand is how
 * they drift.
 */
export const DAEMON_VERSION = '0.16.2';
