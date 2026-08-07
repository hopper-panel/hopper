import { allocationForRole, type ServerConfiguration } from '@hopper/shared';
import { RconError } from './rcon.js';

/**
 * Where an RCON connection goes, with which password, and what to say when it
 * does not work.
 *
 * Three things in this daemon speak RCON — the readiness check, the stop, and
 * the console — and they must not answer those questions separately. The
 * failure of private answers is not that one of them is wrong: it is that they
 * disagree, so a template whose readiness check logs in perfectly well is
 * stopped by a connection that goes somewhere else, and nothing in either
 * message says the two were ever meant to be the same address.
 *
 * Pure, so every path can be tested without a socket.
 */

export interface RconTarget {
  host: string;
  port: number;
  password: string;
}

/** A refusal, phrased as a fragment its caller can put behind "cannot X: ". */
export interface RconRefusal {
  refusal: string;
}

/**
 * The address the daemon dials for a port the container publishes.
 *
 * An allocation's `ip` is the address Docker publishes *on the host*, and
 * `0.0.0.0` means "every interface" — which is a bind address and not somewhere
 * anything can connect to. Dialling it works on Linux by accident of the
 * kernel's own routing and fails elsewhere; the loopback is what "every
 * interface" includes and is reachable by name.
 */
export function dialHost(ip: string): string {
  return ip === '0.0.0.0' ? '127.0.0.1' : ip;
}

/**
 * The password a template variable holds.
 *
 * The variable is named in the configuration and resolved here, against the
 * server's environment, at the moment of connecting — never carried in the
 * configuration itself, which travels over the wire and into logs.
 *
 * An unset variable is a refusal and not an empty password. RCON with an empty
 * password is not a weaker login, it is a different failure: most servers
 * disable RCON entirely when their password is blank, so the connection is
 * refused at the socket and the operator is told the server is unreachable when
 * what is actually wrong is a variable nobody filled in.
 */
export function rconPassword(
  environment: Record<string, string>,
  secretVariable: string,
): { password: string } | RconRefusal {
  const password = environment[secretVariable];

  if (!password) {
    return {
      refusal: `the variable ${secretVariable} holds this server's RCON password and is not set. Set it in the server's Startup tab`,
    };
  }

  return { password };
}

/**
 * A role and a variable name, turned into something to connect to.
 *
 * The role is resolved through `allocationForRole` — the contract's single
 * definition of what a name means — so this agrees with the readiness path and
 * with the startup command's `{{server.allocations.<role>.port}}` by
 * construction rather than by everyone remembering the same rule.
 *
 * A role matching no port is **refused**, exactly as it is for readiness, and
 * for a sharper reason here: reading it as "the primary one then" sends the
 * RCON handshake to the game port, where nothing answers it, and the stop that
 * follows a handshake going nowhere is the SIGKILL this transport was chosen to
 * avoid. The refusal names the role and where to create it, because a role that
 * matches nothing is usually not a mistake in the template — it is a template
 * naming a port the operator has not made yet.
 */
export function resolveRconTarget(
  configuration: Pick<ServerConfiguration, 'allocations' | 'environment'>,
  target: { role?: string; secretVariable: string },
): RconTarget | RconRefusal {
  const allocation = allocationForRole(configuration.allocations, target.role);

  if (!allocation) {
    return {
      refusal:
        `no port on this server is named "${target.role}", so there is nowhere to send it. ` +
        "Name one in the server's Network tab, or drop the name from the template to use the primary port",
    };
  }

  const secret = rconPassword(configuration.environment, target.secretVariable);

  if ('refusal' in secret) {
    return secret;
  }

  return { host: dialHost(allocation.ip), port: allocation.port, password: secret.password };
}

/**
 * Why an exchange that got as far as the socket failed, in the same phrasing
 * `RconRefusal` uses so a caller can put either behind "cannot X: ".
 *
 * The distinction it draws is the one worth drawing, and it is the same for a
 * stop and for a console command: a refused password and a port with nothing
 * behind it look identical from the panel and have nothing in common to fix.
 * One is a value the operator can see and correct in the Startup tab; the other
 * is a server that is not listening where its template says it is.
 *
 * Shared rather than written out at each call site, because the two would drift
 * and the drift would be invisible — an operator would learn to read one
 * message and meet the other months later, for the same fault.
 */
export function describeRconFailure(
  error: unknown,
  target: Pick<RconTarget, 'host' | 'port'>,
  secretVariable: string,
): string {
  const detail = error instanceof Error ? error.message : String(error);

  return error instanceof RconError && detail.includes('refused the password')
    ? `RCON refused the password held in ${secretVariable}. It has to be the one this server is itself configured with`
    : `nothing answered RCON at ${target.host}:${target.port} (${detail}). Check that this server has RCON enabled and listening on that port`;
}
