import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/** The panel writes here; a root unit watches the directory. See `request`. */
const TRIGGER_NAME = 'requested';
const STATUS_NAME = 'status.json';

/** Where `install.sh` lays the root-side unit down. */
const UNIT_PATH = '/etc/systemd/system/hopper-node-apply.path';

export type NodeApplyState = 'idle' | 'requested' | 'running' | 'succeeded' | 'failed';

export interface NodeApplyStatus {
  state: NodeApplyState;
  /** True when this machine has the root-side unit installed. */
  available: boolean;
  startedAt?: string;
  finishedAt?: string;
  /** The tail of the unit's journal, when it failed. */
  log?: string;
  /** What to run by hand when `available` is false. */
  manualCommand: string;
}

/**
 * Applying a node's configuration to the machine the panel runs on.
 *
 * Creating a node hands the operator a YAML document and three instructions:
 * write it to `/etc/hopper/daemon.yml`, `chmod 600` it, restart hopperd. Every
 * one of those is a step that can be got wrong, and the middle one is got wrong
 * in a way that reads as a different bug entirely: a file left at 0644 makes
 * hopperd exit 78 at every start, five times, and then stop trying — while the
 * panel reports the node as merely unreachable.
 *
 * Watched happening. The operator had piped the configuration through `tee`,
 * which recreates the file at the shell's umask, and spent the evening looking
 * for a network problem.
 *
 * So the panel asks instead, through the same mechanism updates use: it writes
 * a node's uuid into a directory it is allowed to write, and a root-owned path
 * unit reacts. **It names a node and nothing else.** Where the file goes, what
 * mode it gets and which service is restarted are fixed in the unit, which the
 * panel can neither read nor alter. A compromised panel gains "point this
 * machine's daemon at one of my own nodes" — which the API already grants
 * through token rotation — rather than "run anything as root".
 *
 * Only for the machine the panel runs on. A second machine still needs the
 * document copied to it, because nothing here can reach across the wire to
 * write a root-owned file on somebody else's host, and it should not be able to.
 */
@Injectable()
export class NodeApplyService {
  private readonly logger = new Logger(NodeApplyService.name);

  /** Directory shared with the root-side unit. */
  private get spool(): string {
    return process.env.HOPPER_NODE_APPLY_DIR ?? '/var/lib/hopper/node-apply';
  }

  private get unitPath(): string {
    return process.env.HOPPER_NODE_APPLY_UNIT ?? UNIT_PATH;
  }

  async status(): Promise<NodeApplyStatus> {
    // Both halves, because either one missing makes the button a lie. The
    // units shipped a release before the directory they share did, so every
    // installation had `available: true` and a spool the panel could not
    // create: /var/lib/hopper belongs to root.
    const available = (await this.installed()) && (await this.writable());

    let recorded: Partial<NodeApplyStatus> = {};

    try {
      recorded = JSON.parse(
        await readFile(join(this.spool, STATUS_NAME), 'utf8'),
      ) as Partial<NodeApplyStatus>;
    } catch {
      // No file yet is the normal state of a machine nobody has asked
      // anything of, not an error to report.
    }

    return {
      state: recorded.state ?? 'idle',
      available,
      startedAt: recorded.startedAt,
      finishedAt: recorded.finishedAt,
      log: recorded.log,
      manualCommand: this.manualCommand(),
    };
  }

  /**
   * Asks the root-side unit to write this machine's `daemon.yml`.
   *
   * Refused outright when the unit is absent rather than left to fail silently:
   * the trigger file would sit in a directory nothing watches, the interface
   * would report `requested` for ever, and the operator would be waiting on a
   * machine that was never going to act.
   */
  async request(nodeUuid: string): Promise<void> {
    if (!(await this.installed())) {
      throw new ServiceUnavailableException(
        `This machine has no local daemon updater installed, so the panel cannot write its configuration. Run it by hand: ${this.manualCommand()}`,
      );
    }

    try {
      // The failure this catches was not hypothetical: `install.sh` created
      // the updater's spool and not this one, so `mkdir` raised EACCES, the
      // first version of this line swallowed it, and the write below failed
      // with a permission error that reached the operator as the five words
      // "Internal server error".
      await mkdir(this.spool, { recursive: true });

      await writeFile(
        join(this.spool, STATUS_NAME),
        JSON.stringify({ state: 'requested', startedAt: new Date().toISOString() }),
        'utf8',
      );

      // Written last: the path unit fires on this file, and a trigger landing
      // before the status would leave the interface reporting `idle` while the
      // work is already under way.
      await writeFile(join(this.spool, TRIGGER_NAME), nodeUuid, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
      this.logger.error(`Cannot write ${this.spool}: ${String(error)}`);

      throw new ServiceUnavailableException(
        `The panel cannot write ${this.spool} (${code}), so it cannot ask this machine to configure itself. ` +
          `Reinstalling repairs it — or do it by hand: ${this.manualCommand()}`,
      );
    }

    this.logger.log(`Local daemon configuration requested for node ${nodeUuid}.`);
  }

  /** The two commands an operator runs when the unit is not installed. */
  manualCommand(): string {
    return 'sudo hopper node:token --node <name> --output /etc/hopper/daemon.yml && sudo systemctl restart hopperd';
  }

  /**
   * Whether the panel's account can actually put a file in the spool.
   *
   * The directory is checked when it is there and its parent when it is not,
   * because "nothing has asked yet" and "the panel is locked out of the
   * directory" look identical from a bare `access` on a path that does not
   * exist — and they are opposite answers.
   */
  private async writable(): Promise<boolean> {
    try {
      await access(this.spool, constants.W_OK);
      return true;
    } catch {
      try {
        await access(dirname(this.spool), constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
  }

  private async installed(): Promise<boolean> {
    try {
      await readFile(this.unitPath, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}
