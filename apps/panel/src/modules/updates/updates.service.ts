import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import { PANEL_VERSION } from '../../version.js';

const run = promisify(execFile);

/**
 * The repository the update check reads, frozen in code.
 *
 * Deliberately not a setting. An administrator who could point this at an
 * arbitrary host would turn the check into a request the panel makes on their
 * behalf, from inside the network — the SSRF the webhook guard exists to
 * prevent, handed over through the settings page instead.
 */
const REPOSITORY = 'hopper-panel/hopper';
const GITHUB_API = 'https://api.github.com';

/** How long a check is reused. GitHub allows sixty unauthenticated calls an hour. */
const CACHE_MS = 30 * 60 * 1000;

/** The panel writes here; a root unit watches the directory. See `requestUpdate`. */
const TRIGGER_NAME = 'requested';
const STATUS_NAME = 'status.json';

export interface UpdateCheck {
  /** Version compiled into this build. `0.0.0-dev` outside a release. */
  version: string;
  /** Commit the installation sits on, when it is a git checkout. */
  commit: string | null;
  commitDate: string | null;
  /** Latest release tag, or the head of the default branch when none exists. */
  latest: string | null;
  latestDate: string | null;
  /** Null when the check could not reach GitHub — never silently "up to date". */
  updateAvailable: boolean | null;
  /** Why the check could not conclude, for the interface to show as is. */
  reason?: string;
  checkedAt: string;
}

export type UpdateState = 'idle' | 'requested' | 'running' | 'succeeded' | 'failed';

export interface UpdateStatus {
  state: UpdateState;
  /** True when the machine has the root-side updater installed. */
  supported: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** Tail of the updater's log, for a failure an operator has to read. */
  log?: string;
}

/**
 * Panel updates: telling an operator one exists, and applying it.
 *
 * The panel cannot update itself, and that is the point rather than an
 * oversight. It runs as an unprivileged account under a unit with
 * `ProtectSystem=strict` and no writable path; installing code means writing to
 * `/opt/hopper` and restarting services, which is root's work.
 *
 * So the panel asks. It creates one empty file in a directory it is allowed to
 * write, and a root-owned systemd path unit reacts to it. The panel cannot say
 * *what* to run, only that an update was asked for: no command, no argument, no
 * shell. A compromised panel gains "trigger the updater", not "run anything as
 * root" — which is what a sudoers rule would have handed it.
 */
@Injectable()
export class UpdatesService {
  private readonly logger = new Logger(UpdatesService.name);
  private cached: UpdateCheck | null = null;

  /** Root of the installation, the git checkout install.sh leaves behind. */
  private get root(): string {
    return process.env.HOPPER_ROOT ?? process.cwd();
  }

  /** Directory shared with the root-side updater. */
  private get spool(): string {
    return process.env.HOPPER_UPDATE_DIR ?? '/var/lib/hopper/updates';
  }

  async check(force = false): Promise<UpdateCheck> {
    if (!force && this.cached && Date.now() - Date.parse(this.cached.checkedAt) < CACHE_MS) {
      return this.cached;
    }

    const local = await this.localCommit();
    const remote = await this.latestRelease();

    const check: UpdateCheck = {
      version: PANEL_VERSION,
      commit: local?.commit ?? null,
      commitDate: local?.date ?? null,
      latest: remote.ref,
      latestDate: remote.date,
      // Unknown stays unknown. Reporting "up to date" because GitHub timed out
      // would be the one answer an operator must never be given.
      updateAvailable: remote.ref === null ? null : this.isBehind(local?.commit ?? null, remote),
      ...(remote.reason ? { reason: remote.reason } : {}),
      checkedAt: new Date().toISOString(),
    };

    this.cached = check;
    return check;
  }

  private isBehind(local: string | null, remote: { ref: string | null; commit: string | null }) {
    // A released build compares tags; a checkout compares commits. Without a
    // release to compare against, an installation that tracks main is behind
    // as soon as its commit differs from the branch head.
    if (remote.commit && local) {
      return remote.commit !== local;
    }

    return remote.ref !== null && remote.ref !== PANEL_VERSION;
  }

  /**
   * The commit this installation is running.
   *
   * Read from a file install.sh writes, **not** from git: the installer copies
   * the sources with `--exclude=.git`, so an installed panel sits in a
   * directory that is not a checkout and cannot say which revision it holds.
   *
   * The first version of this asked git and got nothing, which left the
   * comparison falling back to tags — and a tag compared against `0.0.0-dev`
   * differs always, so the administration announced an update on an
   * installation that was perfectly current.
   *
   * git is still tried afterwards, for the development checkout where no
   * installer has run.
   */
  private async localCommit(): Promise<{ commit: string; date: string | null } | null> {
    try {
      const recorded = (await readFile(join(this.root, '.hopper-commit'), 'utf8')).trim();

      if (/^[0-9a-f]{40}$/.test(recorded)) {
        return { commit: recorded, date: null };
      }
    } catch {
      // No file: either a development checkout, or an installation made before
      // the installer recorded it. git answers for the first case.
    }

    try {
      const { stdout } = await run('git', ['-C', this.root, 'log', '-1', '--format=%H %cI'], {
        timeout: 5000,
      });
      const [commit, date] = stdout.trim().split(' ');

      return commit && date ? { commit, date } : null;
    } catch {
      return null;
    }
  }

  private async latestRelease(): Promise<{
    ref: string | null;
    commit: string | null;
    date: string | null;
    reason?: string;
  }> {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'hopper-panel' };

    try {
      const release = await fetch(`${GITHUB_API}/repos/${REPOSITORY}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (release.ok) {
        const body = (await release.json()) as { tag_name?: string; published_at?: string };
        return { ref: body.tag_name ?? null, commit: null, date: body.published_at ?? null };
      }

      // 404 is the normal answer before the first release, not a failure: the
      // check then follows the default branch, which is what an installation
      // made by install.sh actually tracks.
      if (release.status !== 404) {
        return {
          ref: null,
          commit: null,
          date: null,
          reason: `GitHub answered ${release.status}.`,
        };
      }

      const branch = await fetch(`${GITHUB_API}/repos/${REPOSITORY}/commits/main`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });

      if (!branch.ok) {
        return { ref: null, commit: null, date: null, reason: `GitHub answered ${branch.status}.` };
      }

      const body = (await branch.json()) as {
        sha?: string;
        commit?: { committer?: { date?: string } };
      };

      return {
        ref: body.sha ? body.sha.slice(0, 7) : null,
        commit: body.sha ?? null,
        date: body.commit?.committer?.date ?? null,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Update check could not reach GitHub: ${reason}`);
      return { ref: null, commit: null, date: null, reason: 'GitHub is unreachable.' };
    }
  }

  async status(): Promise<UpdateStatus> {
    const supported = await this.updaterInstalled();

    try {
      const raw = await readFile(join(this.spool, STATUS_NAME), 'utf8');
      const parsed = JSON.parse(raw) as Partial<UpdateStatus>;

      return { state: parsed.state ?? 'idle', supported, ...parsed };
    } catch {
      return { state: 'idle', supported };
    }
  }

  /**
   * Asks the root-side updater to run.
   *
   * Writing the file is the whole request. Everything the update does is
   * decided by the unit that reacts to it, which the panel cannot alter: it has
   * no write access to `/etc/systemd`, and nothing here passes an argument.
   */
  async requestUpdate(): Promise<void> {
    await mkdir(this.spool, { recursive: true }).catch(() => undefined);

    await writeFile(
      join(this.spool, STATUS_NAME),
      JSON.stringify({ state: 'requested', startedAt: new Date().toISOString() }),
      'utf8',
    );

    // Written last: the path unit fires on this file, and a trigger landing
    // before the status would leave the interface reporting `idle` while the
    // update is already running.
    await writeFile(join(this.spool, TRIGGER_NAME), '', 'utf8');
    this.logger.log('Update requested; the system updater will take over.');
  }

  /** True when install.sh has laid down the root-side unit. */
  private async updaterInstalled(): Promise<boolean> {
    try {
      await readFile('/etc/systemd/system/hopper-update.path', 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** The command an operator runs when the updater is not installed. */
  manualCommand(): string {
    return `sudo bash ${join(this.root, 'install', 'install.sh')}`;
  }

  /** Exposed for the tests: the directory the trigger lands in. */
  get spoolDirectory(): string {
    return this.spool;
  }

  /** Exposed for the tests: parent of the spool, created by install.sh. */
  get spoolParent(): string {
    return dirname(this.spool);
  }
}
