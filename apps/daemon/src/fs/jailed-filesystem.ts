import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';

/**
 * `O_NOFOLLOW` makes `open(2)` fail with `ELOOP` when the **final** component of
 * the path is a symlink, whatever it points at.
 *
 * Windows has no such flag and no symlinks worth the name without elevation, so
 * it is absent from `fs.constants` there. Zero is the neutral element of the
 * flag OR, which degrades the development machine to the behaviour it already
 * had while production — Linux — gets the guarantee.
 */
const O_NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/** A symlink chain longer than this is a loop, whoever built it. */
const MAX_LINK_HOPS = 32;

/**
 * Access to a server's filesystem, confined to its volume.
 *
 * **Every** operation on a server's files goes through this class. It is the
 * most important rule in the daemon: a single direct `fs.readFile` on a path
 * that came from a request is enough to give the user of a Minecraft server
 * read access to `/etc/shadow` or write access to `/etc/cron.d`.
 *
 * Four mechanisms are stacked, because none is enough on its own:
 *
 *  1. **Normalisation** — `../../etc/passwd` is reduced then compared to the
 *     root. Kills naive traversal.
 *  2. **Real resolution** — the path is resolved through symlinks. Without it,
 *     `ln -s / escape` then `escape/etc/passwd` would sail through
 *     normalisation, and the user can create that link themselves from their
 *     own console.
 *  3. **Refusal to follow at the last step** — the three above all describe the
 *     filesystem as it was when they ran. The server's own process keeps
 *     running, and rewriting a name after it has been vetted costs it one
 *     `ln -s`. So the write itself is opened with `O_NOFOLLOW`, which moves the
 *     decision into the `open(2)` call and leaves no window to aim at. Nothing
 *     here re-opens a path by name after resolving it.
 *  4. **Denylist** — some files stay forbidden even inside the volume: a
 *     proxy's forwarding secret, for instance, would allow impersonating any
 *     player.
 *
 * Paths handled outside this class are always **relative to the volume and in
 * POSIX separators** (`plugins/config.yml`). The absolute host path never
 * leaves here: it would otherwise surface in an error message returned to the
 * user, revealing the machine's directory tree.
 */

export class PathEscapeError extends Error {
  constructor(readonly requestedPath: string) {
    super('Path outside the server directory.');
    this.name = 'PathEscapeError';
  }
}

export class DeniedFileError extends Error {
  constructor(readonly requestedPath: string) {
    super('This file is protected and cannot be read or modified.');
    this.name = 'DeniedFileError';
  }
}

export class NotFoundError extends Error {
  constructor(readonly requestedPath: string) {
    super('File or folder not found.');
    this.name = 'NotFoundError';
  }
}

export class QuotaExceededError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly limitBytes: number,
  ) {
    super('The server has reached its disk limit.');
    this.name = 'QuotaExceededError';
  }
}

/**
 * Disk allowance of a server, as the jail sees it.
 *
 * `usedBytes` is a **snapshot**, not a live figure: measuring a volume means
 * walking it, which costs seconds on a large world, so the daemon samples it
 * periodically. A server can therefore overshoot its limit by whatever it
 * writes between two measurements.
 *
 * That slack is deliberate. The alternative — walking the volume before every
 * write — would make the file manager unusable on the servers that need the
 * limit most. What matters is that a server cannot grow indefinitely, not that
 * the ceiling is exact to the byte.
 */
export interface DiskQuota {
  usedBytes: number;
  /** 0 means no limit, matching the convention of the other build limits. */
  limitBytes: number;
}

export interface FileEntry {
  name: string;
  /** Path relative to the volume, POSIX separators. */
  path: string;
  directory: boolean;
  /** True for a symlink, whatever its target. */
  symlink: boolean;
  sizeBytes: number;
  mode: string;
  modifiedAt: Date;
}

export interface JailOptions {
  /** Volume root on the host. */
  root: string;
  /** Forbidden glob patterns, relative to the root. */
  denylist?: string[];
  /**
   * Container user, owner of everything created here.
   *
   * The daemon writes as root; the server runs under an unprivileged uid.
   * Without taking ownership, every path **created** by the file manager — a
   * plugin folder, an extracted archive, an uploaded file — belonged to root
   * and became unreadable to the server. The symptom shows up much later, as a
   * plugin that cannot write its configuration.
   *
   * Absent on Windows, where `chown` makes no sense.
   */
  ownership?: { uid: number; gid: number };
  /**
   * Current disk allowance, read at each write.
   *
   * A function rather than a value: a jail is built per request, but the usage
   * it has to compare against keeps moving underneath. Capturing the figure at
   * construction would enforce a quota that was true when the request started.
   *
   * Absent means no enforcement — a backup restore writes on behalf of the
   * system, not of a user, and refusing it would leave a half-restored volume.
   */
  quota?: () => DiskQuota;
}

export class JailedFilesystem {
  private readonly denylist: RegExp[];
  /** Resolved root, computed once: it may itself be a link. */
  private resolvedRoot: string | null = null;

  constructor(private readonly options: JailOptions) {
    this.denylist = (options.denylist ?? []).map(globToRegExp);
  }

  private async root(): Promise<string> {
    if (this.resolvedRoot === null) {
      await mkdir(this.options.root, { recursive: true });
      this.resolvedRoot = await realpath(this.options.root);
    }

    return this.resolvedRoot;
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Turns a user-supplied path into an absolute host path.
   *
   * @throws {PathEscapeError} if the path leaves the volume, directly or
   *   through a symlink.
   * @throws {DeniedFileError} if the path is on the denylist.
   */
  async resolvePath(userPath: string): Promise<string> {
    const root = await this.root();
    const relativePath = this.toRelative(userPath);

    this.assertNotDenied(relativePath);

    const candidate = resolve(root, relativePath);

    // First barrier: after normalisation the path must stay under the root.
    // Catches `../../etc/passwd` and absolute paths.
    if (!isInside(root, candidate)) {
      throw new PathEscapeError(userPath);
    }

    // Second barrier: real resolution. The target file may not exist yet — so
    // resolve the longest existing ancestor, then check the rest does not come
    // back out.
    const resolved = await this.realpathOfLongestExistingPrefix(candidate);

    if (!isInside(root, resolved)) {
      throw new PathEscapeError(userPath);
    }

    // It is the **resolved** path that is returned, not the supplied one.
    //
    // Returning the original would let the filesystem walk the links again at
    // operation time, a second time after the check. A user who swaps the link
    // in between — they can, from their console as well as over SFTP — would
    // have the write land on a target nobody vetted. Working on the
    // already-resolved path leaves no link to walk.
    return resolved;
  }

  /**
   * Resolves symlinks over the existing portion of a path.
   *
   * `realpath` fails on a non-existent path, yet we have to be able to write a
   * file that does not exist yet. So we walk up to the first existing ancestor,
   * resolve it, and reattach the rest.
   *
   * The walk probes with `lstat`, never with `access`. `access(2)` **follows**
   * links, so it answers ENOENT for a link whose target does not exist — and
   * the loop then files that name under "missing" and reattaches it unresolved.
   * A dangling link is trivial to plant from inside the container:
   *
   *     ln -s /etc/cron.d/backdoor /home/container/notes.txt
   *
   * `notes.txt` is then reported as a free name, the jail hands back
   * `<volume>/notes.txt` having checked nothing, and the write that follows
   * walks the link and creates the target — as root, outside the volume. There
   * is no race to win here: the escape is deterministic. `lstat` describes the
   * link itself, so the name is seen for what it is.
   */
  private async realpathOfLongestExistingPrefix(candidate: string): Promise<string> {
    let existing = candidate;
    const missing: string[] = [];

    for (;;) {
      const stats = await lstat(existing).catch(() => null);

      if (stats) {
        // `realpath` throws ENOENT on a dangling link rather than telling us
        // where it points, which is precisely what we need to know in order to
        // reject it. Follow the chain by hand in that case.
        const resolved = stats.isSymbolicLink()
          ? await this.followLinkChain(existing)
          : await realpath(existing);

        return join(resolved, ...missing);
      }

      const parent = dirname(existing);

      // System root reached: nothing left to walk up.
      if (parent === existing) {
        return candidate;
      }

      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  /**
   * Where a link points, whether or not its target exists.
   *
   * Stops at the first name that is not a link and resolves that through
   * `realpath`, so the directories along the way are resolved too. A chain
   * longer than {@link MAX_LINK_HOPS} is a loop — the kernel calls it ELOOP; we
   * return the last hop, which the containment check then rejects for being
   * where it is rather than for how it was reached.
   */
  private async followLinkChain(linkPath: string): Promise<string> {
    let current = linkPath;

    for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
      const target = await readlink(current).catch(() => null);

      if (target === null) {
        return realpath(current).catch(() => current);
      }

      current = resolve(dirname(current), target);

      const stats = await lstat(current).catch(() => null);

      if (!stats) {
        // Dangling: the chain ends here, at a name that does not exist. Its
        // *location* is what matters, and that is what we hand back.
        return current;
      }

      if (!stats.isSymbolicLink()) {
        return realpath(current).catch(() => current);
      }
    }

    return current;
  }

  /** Normalises a user path into a relative path that is safe to handle. */
  private toRelative(userPath: string): string {
    // Windows separators are accepted as input: an SFTP client or a browser can
    // send them, and rejecting them would gain nothing.
    const unified = userPath.replace(/\\/g, '/');

    // A null byte truncates the path in C system calls: `a\0../..` would be
    // seen as `a` by the check and as something else by the kernel. Node
    // already throws on this, but we reject it explicitly. `includes` on the
    // string rather than a regular expression: looking for a control character
    // in a regex trips `no-control-regex`, and a lint exception would draw
    // attention to the wrong thing.
    if (unified.includes('\0')) {
      throw new PathEscapeError(userPath);
    }

    const normalized = posix.normalize(unified);
    const withoutLeadingSlash = normalized.replace(/^\/+/, '');

    return withoutLeadingSlash === '' ? '.' : withoutLeadingSlash;
  }

  private assertNotDenied(relativePath: string): void {
    const posixPath = relativePath.split(sep).join('/');

    if (this.denylist.some((pattern) => pattern.test(posixPath))) {
      throw new DeniedFileError(relativePath);
    }
  }

  /** Path relative to the volume, POSIX separators, for the outside world. */
  private async toUserPath(absolute: string): Promise<string> {
    const root = await this.root();
    return relative(root, absolute).split(sep).join('/');
  }

  // -------------------------------------------------------------------------
  // Opening without following
  // -------------------------------------------------------------------------

  /**
   * Opens a resolved path for writing, refusing a link at the last step.
   *
   * `resolvePath` decides what a name means; this decides what the kernel does
   * with it. The two have to be separate, because between the deciding and the
   * doing the server's own process keeps running and can rewrite the name:
   *
   *     while :; do ln -sf /etc/cron.d/backdoor /home/container/plugin.yml; done
   *
   * A check, however careful, describes the filesystem as it was. `O_NOFOLLOW`
   * moves the decision into the `open(2)` call itself: the kernel refuses with
   * `ELOOP` if the final component is a link at the instant it is opened. There
   * is no window left to aim at.
   *
   * `O_TRUNC` is deliberately absent. Truncation is applied *after* the
   * descriptor has been vetted — asking for it in the flags would empty a file
   * we are about to reject, which turns a refused write into a successful
   * deletion.
   *
   * The flag guards the final component only. The directories above it were
   * resolved by `resolvePath`, and swapping one of *those* for a link
   * afterwards is a race `O_NOFOLLOW` cannot see: Node exposes no `openat`, so
   * there is no way to hold a parent by descriptor and walk down from it.
   * {@link assertHandleInside} closes that one where the kernel lets us.
   *
   * The open happens in two steps rather than one `O_CREAT`, and the reason is
   * the refusal path. A single `O_CREAT` creates the file *before* the check
   * that rejects it, and closing the descriptor afterwards leaves it there —
   * which hands the caller an "empty root-owned file at a path of my choosing"
   * primitive. `/etc/nologin` denies every non-root login on the host and is
   * zero bytes. So: open an existing file without `O_CREAT`, and only if that
   * says ENOENT create it with `O_EXCL`. `O_EXCL` is what makes the cleanup
   * sound — it guarantees the file did not exist a moment ago, so unlinking it
   * on refusal removes something this call made and nothing else.
   */
  async openForWrite(absolutePath: string, mode = 0o644): Promise<FileHandle> {
    const existing = await openWithoutFollowing(
      absolutePath,
      fsConstants.O_WRONLY | O_NOFOLLOW,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        return null;
      }

      throw error;
    });

    if (existing !== null) {
      return this.vetHandle(existing, absolutePath, false);
    }

    const created = await openWithoutFollowing(
      absolutePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      mode,
    );

    return this.vetHandle(created, absolutePath, true);
  }

  /**
   * Checks a freshly opened descriptor, and undoes the open if it fails.
   *
   * `weCreatedIt` decides how far the undo goes. A file that was already there
   * is left exactly as found — it was never truncated, because truncation
   * happens only after this returns. One this call brought into being is
   * removed, so a refused write leaves no trace at the place it was refused.
   */
  private async vetHandle(
    handle: FileHandle,
    absolutePath: string,
    weCreatedIt: boolean,
  ): Promise<FileHandle> {
    try {
      await this.assertHandleInside(handle, absolutePath);
      await handle.truncate(0);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);

      if (weCreatedIt) {
        // `unlink`, not `rm`: it removes the name without following it, and the
        // name is the only thing this call is responsible for.
        await unlink(absolutePath).catch(() => undefined);
      }

      throw error;
    }
  }

  /**
   * A write stream onto a vetted descriptor.
   *
   * The streaming callers — an upload, an archive extraction, an SFTP transfer
   * — used to build their own `createWriteStream(path)`, which reopens the name
   * and follows whatever link is sitting on it by then. Handing them a stream
   * over an already-opened descriptor removes the second lookup entirely.
   */
  async createWriteStream(
    absolutePath: string,
    mode = 0o644,
  ): Promise<ReturnType<FileHandle['createWriteStream']>> {
    const handle = await this.openForWrite(absolutePath, mode);
    return handle.createWriteStream();
  }

  /**
   * Opens a resolved path for reading, refusing a link at the last step.
   *
   * Reading needs this as much as writing does, for a reason that is easy to
   * miss: the dangling-link variant does not apply — there is nothing to read
   * through a link whose target does not exist — but the raced one does, and it
   * is the more valuable of the two to an attacker. The owner leaves a genuine
   * file at the name, so resolution passes cleanly, and swaps a link in
   * afterwards:
   *
   *     while :; do ln -sfn /etc/shadow notes.txt; mv -T real notes.txt; done
   *
   * A download that lands in the window has the daemon — root — open the link's
   * target and stream it back with a 200. `/etc/shadow`, the daemon's own node
   * token, another server's volume: whatever the path names.
   */
  async openForRead(absolutePath: string): Promise<FileHandle> {
    const handle = await openWithoutFollowing(absolutePath, fsConstants.O_RDONLY | O_NOFOLLOW);

    try {
      await this.assertHandleInside(handle, absolutePath);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }

    return handle;
  }

  /**
   * A read stream over a vetted descriptor.
   *
   * `start` and `end` carry the byte range SFTP asks for; the HTTP routes read
   * whole files and leave them out.
   */
  async createReadStream(
    absolutePath: string,
    range?: { start?: number; end?: number },
  ): Promise<ReturnType<FileHandle['createReadStream']>> {
    const handle = await this.openForRead(absolutePath);
    return handle.createReadStream(range);
  }

  /**
   * Checks that a descriptor really landed inside the volume.
   *
   * Linux publishes the true path of an open descriptor under `/proc/self/fd`.
   * Reading it *after* the open answers the one question the pre-flight check
   * cannot: not "where should this have gone" but "where did it actually go".
   * It is what catches a parent directory swapped for a link between resolution
   * and open, which `O_NOFOLLOW` is blind to.
   *
   * Silent where `/proc` is not mounted — Windows in development, a stripped
   * container. There `O_NOFOLLOW` is the whole of the guarantee, which is what
   * the daemon had before this and is still far more than the name check alone.
   */
  private async assertHandleInside(handle: FileHandle, requestedPath: string): Promise<void> {
    const actual = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => null);

    if (actual === null) {
      return;
    }

    if (!isInside(await this.root(), actual)) {
      throw new PathEscapeError(requestedPath);
    }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(userPath: string): Promise<FileEntry[]> {
    const absolute = await this.resolvePath(userPath);

    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      throw new NotFoundError(userPath);
    }

    const results: FileEntry[] = [];

    for (const entry of entries) {
      const entryPath = join(absolute, entry.name);
      const relativePath = await this.toUserPath(entryPath);

      // A denied file does not show up in the listing either: showing it
      // without allowing it to be read would only draw attention to it.
      if (this.denylist.some((pattern) => pattern.test(relativePath))) {
        continue;
      }

      // `lstat`, not `stat`: we want to describe the link itself, not its
      // target. Following the target would expose the size of a file located
      // outside the volume.
      const stats = await lstat(entryPath).catch(() => null);

      if (!stats) {
        continue;
      }

      results.push({
        name: entry.name,
        path: relativePath,
        directory: stats.isDirectory(),
        symlink: stats.isSymbolicLink(),
        sizeBytes: stats.isDirectory() ? 0 : stats.size,
        mode: formatMode(stats.mode),
        modifiedAt: stats.mtime,
      });
    }

    // Folders first, then alphabetical: that is what every file manager shows,
    // and departing from it would surprise.
    return results.sort((a, b) => {
      if (a.directory !== b.directory) {
        return a.directory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'en');
    });
  }

  async stat(userPath: string): Promise<FileEntry> {
    const absolute = await this.resolvePath(userPath);
    const stats = await lstat(absolute).catch(() => null);

    if (!stats) {
      throw new NotFoundError(userPath);
    }

    return {
      name: absolute.split(sep).pop() ?? '',
      path: await this.toUserPath(absolute),
      directory: stats.isDirectory(),
      symlink: stats.isSymbolicLink(),
      sizeBytes: stats.isDirectory() ? 0 : stats.size,
      mode: formatMode(stats.mode),
      modifiedAt: stats.mtime,
    };
  }

  /** Absolute host path, for the calls that open a stream. */
  async absolutePathFor(userPath: string): Promise<string> {
    return this.resolvePath(userPath);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Room left before the disk limit, in bytes.
   *
   * `Infinity` when no quota applies, so callers can compare against it without
   * special-casing the unlimited server.
   */
  remainingBytes(): number {
    const quota = this.options.quota?.();

    if (!quota || quota.limitBytes <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.max(0, quota.limitBytes - quota.usedBytes);
  }

  /**
   * Refuses a write that would take the server past its limit.
   *
   * Streaming callers — an upload, an archive extraction — check as they go
   * rather than up front: a client's declared `Content-Length` can lie, and an
   * archive announces nothing at all until it is read.
   */
  assertRoomFor(bytes: number): void {
    const quota = this.options.quota?.();

    if (!quota || quota.limitBytes <= 0) {
      return;
    }

    if (quota.usedBytes + bytes > quota.limitBytes) {
      throw new QuotaExceededError(quota.usedBytes, quota.limitBytes);
    }
  }

  async writeFile(userPath: string, content: string | Buffer): Promise<void> {
    const absolute = await this.resolvePath(userPath);
    // The file being replaced already counts towards the usage, so only the
    // growth is charged. Editing one line of a configuration file on a server
    // sitting at its limit has to keep working.
    //
    // `lstat`, not `stat`: sizing a link would report the size of its target,
    // and a link is refused by the open below in any case.
    const existing = await lstat(absolute).catch(() => null);
    const size = typeof content === 'string' ? Buffer.byteLength(content) : content.length;

    this.assertRoomFor(size - (existing?.isFile() === true ? existing.size : 0));

    await mkdir(dirname(absolute), { recursive: true });

    const handle = await this.openForWrite(absolute);

    try {
      await handle.writeFile(content);
    } finally {
      await handle.close().catch(() => undefined);
    }

    await this.applyOwnership(absolute);
  }

  async createDirectory(userPath: string): Promise<void> {
    const absolute = await this.resolvePath(userPath);
    await mkdir(absolute, { recursive: true });
    await this.applyOwnership(absolute);
  }

  /**
   * Hands an already-resolved path over to the container user.
   *
   * Public because streaming writes — a file upload, an archive extraction —
   * produce their own paths and have to be able to take ownership of them. A
   * failure is ignored: on a filesystem without owners, losing ownership beats
   * losing the write.
   */
  async applyOwnership(absolutePath: string): Promise<void> {
    const ownership = this.options.ownership;

    if (!ownership) {
      return;
    }

    // `lchown`, not `chown`: the latter follows a link and would hand the
    // container user ownership of whatever it points at — `/etc/shadow` is one
    // `ln -s` away. Changing the ownership of the link itself is meaningless on
    // Linux and harmless, which is exactly what we want.
    await lchown(absolutePath, ownership.uid, ownership.gid).catch(() => undefined);
  }

  /**
   * Changes the permissions of a path.
   *
   * The `setuid`/`setgid` bits are out of reach: the contract schema only
   * accepts three octal digits. A setuid binary dropped in a volume would run
   * with its owner's rights and defeat the container boundary.
   *
   * Done through a descriptor rather than a name. `chmod(2)` follows links, and
   * `lchmod(2)` — which would not — exists on BSD but not on Linux, so there is
   * no name-based call that is safe here. Opening read-only with `O_NOFOLLOW`
   * and calling `fchmod` on the result is: the mode lands on the inode that was
   * opened, and a link at the last step never gets opened at all.
   */
  async chmod(userPath: string, mode: number): Promise<void> {
    const absolute = await this.resolvePath(userPath);

    if (O_NOFOLLOW === 0) {
      // Windows: no flag to pass, and opening a directory for `fchmod` fails
      // outright. An `lstat` refusal is what is available, and development is
      // the only place this branch runs.
      const link = await lstat(absolute).catch(() => null);

      if (link?.isSymbolicLink() === true) {
        throw new PathEscapeError(userPath);
      }

      await chmod(absolute, mode & 0o777);
      return;
    }

    const handle = await openWithoutFollowing(absolute, fsConstants.O_RDONLY | O_NOFOLLOW);

    try {
      await this.assertHandleInside(handle, userPath);
      await handle.chmod(mode & 0o777);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async delete(userPaths: string[]): Promise<void> {
    for (const userPath of userPaths) {
      const absolute = await this.resolvePath(userPath);
      const root = await this.root();

      // Deleting the root would empty the server in one go, bypassing server
      // deletion itself.
      if (absolute === root) {
        throw new PathEscapeError(userPath);
      }

      await rm(absolute, { recursive: true, force: true });
    }
  }

  /**
   * Empties the volume without removing it.
   *
   * Reserved for restoring a backup: `delete` refuses the root, and rightly so
   * — no user operation should be able to wipe a server in a single call.
   * Restoring is the one case where that is the intent, and a separate entry
   * point makes that intent explicit rather than loosening `delete`'s guard.
   *
   * The directory itself is kept: it carries the `uid:gid` the container
   * expects, and recreating it would lose them.
   */
  async emptyRoot(): Promise<void> {
    const root = await this.root();

    for (const entry of await readdir(root)) {
      await rm(join(root, entry), { recursive: true, force: true });
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const from = await this.resolvePath(fromPath);
    const to = await this.resolvePath(toPath);

    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  async copy(fromPath: string, toPath: string): Promise<void> {
    const from = await this.resolvePath(fromPath);
    const to = await this.resolvePath(toPath);

    const stats = await stat(from).catch(() => null);

    if (!stats) {
      throw new NotFoundError(fromPath);
    }

    // A copy is pure growth: the source stays. For a directory the size of the
    // entry itself understates the tree, so the check is a floor, not a
    // guarantee — the periodic measurement catches the rest.
    this.assertRoomFor(stats.size);

    await mkdir(dirname(to), { recursive: true });

    const { cp } = await import('node:fs/promises');
    // `dereference: false`: copying a link copies it as a link, without pulling
    // in the content of its target — which could be outside the volume.
    await cp(from, to, { recursive: true, dereference: false, force: true });
  }

  // -------------------------------------------------------------------------
  // Archives
  // -------------------------------------------------------------------------

  /**
   * Checks that an archive entry can be extracted.
   *
   * This is the protection against the "zip slip": an archive can hold an entry
   * named `../../etc/cron.d/backdoor`, and many extraction libraries write it
   * without flinching. Every entry therefore goes through the same resolution
   * as any user path.
   *
   * @returns the absolute destination path.
   * @throws {PathEscapeError} if the entry leaves the destination directory.
   */
  async resolveArchiveEntry(destination: string, entryName: string): Promise<string> {
    const destinationPath = await this.resolvePath(destination);
    const root = await this.root();

    const lexical = resolve(destinationPath, this.toRelative(entryName));

    // Two checks: under the volume root *and* under the requested destination.
    // An archive must not write elsewhere in the volume than where the user
    // asked for it to be extracted.
    if (!isInside(root, lexical) || !isInside(destinationPath, lexical)) {
      throw new PathEscapeError(entryName);
    }

    // Then dereference, exactly as `resolvePath` does for a user-supplied name.
    //
    // Skipping this used to be survivable because the extraction followed links
    // itself; now that the write refuses a link at the last component, a purely
    // lexical answer hands back a path the open rejects. A link *inside* the
    // volume is legitimate — a `logs/latest.log` pointing at today's file is the
    // ordinary case — and one entry landing on it would otherwise tear down the
    // whole extraction and leave a half-written tree.
    const target = await this.realpathOfLongestExistingPrefix(lexical);

    if (!isInside(root, target) || !isInside(destinationPath, target)) {
      throw new PathEscapeError(entryName);
    }

    this.assertNotDenied(await this.toUserPath(target));

    return target;
  }
}

/**
 * `open(2)` with the link refusal translated into the jail's own vocabulary.
 *
 * The kernel signals "the last component is a symlink" with `ELOOP`, the same
 * code it uses for a genuine link loop. Left as-is it reaches the file manager
 * as an opaque `ELOOP` and shows the user a stack trace; as a
 * {@link PathEscapeError} it becomes the same refusal every other escape gets.
 *
 * `EMLINK` is the same refusal on FreeBSD, which reports it there instead.
 *
 * The absolute path carried by the error stays inside the daemon: the file
 * routes log `requestedPath` and answer with a fixed sentence, so naming the
 * exact path the kernel refused helps the operator reading the log without
 * describing the host's directory tree to the user who probed it.
 */
async function openWithoutFollowing(
  absolutePath: string,
  flags: number,
  mode?: number,
): Promise<FileHandle> {
  try {
    return await open(absolutePath, flags, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new PathEscapeError(absolutePath);
    }

    throw error;
  }
}

/** `rwxr-xr-x` from a POSIX mode. */
export function formatMode(mode: number): string {
  const permissions = ['r', 'w', 'x'];

  return Array.from({ length: 9 }, (_unused, index) => {
    const bit = 1 << (8 - index);
    return (mode & bit) === 0 ? '-' : permissions[index % 3]!;
  }).join('');
}

/**
 * Is a path inside a directory?
 *
 * The comparison includes the separator: without it, `/var/lib/hopper-evil`
 * would pass for being under `/var/lib/hopper`.
 */
export function isInside(parent: string, candidate: string): boolean {
  if (candidate === parent) {
    return true;
  }

  const normalizedParent = parent.endsWith(sep) ? parent : parent + sep;
  return candidate.startsWith(normalizedParent);
}

/**
 * Translates a simple glob pattern into a regular expression.
 *
 * Deliberately limited to `*` (one segment) and `**` (several): template
 * denylists use nothing else, and a full glob implementation would be a
 * needless surface for mistakes somewhere a mistake costs an exposed file.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split(sep)
    .join('/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**` is set aside before `*`, otherwise replacing `*` would cut it in
    // two. The temporary marker is a null byte rather than a space: a space can
    // appear in a legitimate file name — "My World/**" — and would then be
    // turned into `.*`, widening the pattern far beyond what its author meant.
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*')
    .replace(/\?/g, '[^/]');

  return new RegExp(`^${escaped}$`);
}

/** Is a user path absolute, in one form or another? */
export function looksAbsolute(userPath: string): boolean {
  return (
    isAbsolute(userPath) || /^[a-zA-Z]:[\\/]/.test(userPath) || normalize(userPath).startsWith('/')
  );
}
