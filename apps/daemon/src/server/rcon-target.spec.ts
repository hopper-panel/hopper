import type { ServerConfiguration } from '@hopper/shared';
import { describe, expect, it } from 'vitest';
import { dialHost, rconPassword, resolveRconTarget } from './rcon-target.js';

/**
 * Where an RCON connection goes, and with which password.
 *
 * Both things that speak RCON in this daemon ask this — the readiness check and
 * the stop — and the failure worth testing is not either one being wrong on its
 * own. It is the two disagreeing: a server whose readiness check logs in
 * perfectly well and whose stop goes somewhere else, with neither message
 * saying the two were meant to be the same address.
 */

const configuration = (
  allocations: unknown,
  environment: Record<string, string> = { RCON_PASSWORD: 'hunter2' },
): Pick<ServerConfiguration, 'allocations' | 'environment'> =>
  ({ allocations, environment }) as Pick<ServerConfiguration, 'allocations' | 'environment'>;

const WITH_NAMED_PORT = configuration({
  default: { ip: '0.0.0.0', port: 27015 },
  additional: [{ ip: '0.0.0.0', port: 27020, role: 'rcon' }],
});

describe('dialHost', () => {
  it('dials the loopback for a port published on every interface', () => {
    // `0.0.0.0` is a bind address, not somewhere anything connects to.
    // Dialling it works on Linux by accident of the kernel's routing and fails
    // elsewhere; the loopback is what "every interface" includes.
    expect(dialHost('0.0.0.0')).toBe('127.0.0.1');
  });

  it('leaves a real address alone', () => {
    expect(dialHost('10.0.0.4')).toBe('10.0.0.4');
  });
});

describe('rconPassword', () => {
  it('resolves the variable against the server environment', () => {
    expect(rconPassword({ RCON_PASSWORD: 'hunter2' }, 'RCON_PASSWORD')).toEqual({
      password: 'hunter2',
    });
  });

  it('refuses an unset variable rather than connecting with nothing', () => {
    // An empty password is not a weaker login, it is a different failure: most
    // servers disable RCON outright when the password is blank, so the socket
    // is refused and the operator is told the server is unreachable when what
    // is wrong is a variable nobody filled in.
    const refused = rconPassword({}, 'RCON_PASSWORD');

    expect(refused).toHaveProperty('refusal');
    expect((refused as { refusal: string }).refusal).toContain('RCON_PASSWORD');
  });

  it('treats an empty value the same as an absent one', () => {
    expect(rconPassword({ RCON_PASSWORD: '' }, 'RCON_PASSWORD')).toHaveProperty('refusal');
  });
});

describe('resolveRconTarget', () => {
  it('resolves the port the role names, not the game port', () => {
    // The case names exist for: RCON almost never listens on the game's own
    // port. Sending the handshake to 27015 here would reach the game, get
    // nothing back, and the stop that follows is a SIGKILL through the save.
    expect(
      resolveRconTarget(WITH_NAMED_PORT, { role: 'rcon', secretVariable: 'RCON_PASSWORD' }),
    ).toEqual({ host: '127.0.0.1', port: 27020, password: 'hunter2' });
  });

  it('resolves the primary port when the stop names no role', () => {
    // What every configuration written before names existed means, and what it
    // has to go on meaning.
    expect(resolveRconTarget(WITH_NAMED_PORT, { secretVariable: 'RCON_PASSWORD' })).toEqual({
      host: '127.0.0.1',
      port: 27015,
      password: 'hunter2',
    });
  });

  it('refuses a role naming no port on this server, and says where to make one', () => {
    // Never "the primary one then". That reading is what sends the handshake
    // to the game port. The refusal has to name the role, because a role that
    // matches nothing is usually not a mistake in the template — it is a
    // template naming a port the operator has not created yet.
    const refused = resolveRconTarget(WITH_NAMED_PORT, {
      role: 'query',
      secretVariable: 'RCON_PASSWORD',
    });

    expect(refused).toHaveProperty('refusal');
    expect((refused as { refusal: string }).refusal).toContain('query');
    expect((refused as { refusal: string }).refusal).toContain('Network tab');
  });

  it('refuses a missing password before dialling anything', () => {
    const refused = resolveRconTarget(
      configuration({ default: { ip: '0.0.0.0', port: 27015 }, additional: [] }, {}),
      { secretVariable: 'RCON_PASSWORD' },
    );

    expect(refused).toHaveProperty('refusal');
  });
});
