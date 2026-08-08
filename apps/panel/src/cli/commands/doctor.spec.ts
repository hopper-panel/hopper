import { describe, expect, it } from 'vitest';
import { describeDockerProbe, describeNetworkIsolation } from './doctor.js';

/**
 * `hopper doctor` exits 1 as soon as one check fails, so that an installation
 * can end with `install.sh && hopper doctor`. A check that fails on a correct
 * configuration therefore breaks that chain — which is exactly what the Docker
 * probe did before this test existed.
 */
describe('describeDockerProbe', () => {
  it('reports the engine version when the socket answers', () => {
    const check = describeDockerProbe({ status: 'answered', version: '27.3.1' });

    expect(check.level).toBe('ok');
    expect(check.detail).toContain('27.3.1');
  });

  // The panel runs as `hopper`, the socket belongs to root. Refusing the panel
  // is the intended configuration: putting it in the `docker` group would give
  // the internet-facing process root on the host.
  it('treats a refused socket as healthy, not as a failure', () => {
    const check = describeDockerProbe({ status: 'forbidden' });

    expect(check.level).toBe('ok');
    expect(check.detail).toContain('hopperd');
  });

  // A silent socket means the engine is down. On a machine hosting servers that
  // is fatal, and the one Docker case that deserves the exit code.
  it('fails when the socket is there and nothing answers', () => {
    const check = describeDockerProbe({ status: 'silent', reason: 'ECONNREFUSED' });

    expect(check.level).toBe('fail');
    expect(check.detail).toContain('ECONNREFUSED');
  });

  it('warns on an answer it cannot read', () => {
    expect(describeDockerProbe({ status: 'unreadable' }).level).toBe('warn');
  });
});

/**
 * The isolation between the servers on a node, as `hopper doctor` puts it.
 *
 * It is here because the daemon's own report is a log line at startup, and a log
 * line at startup is not where an operator looks. `doctor` is what somebody runs
 * when a node smells wrong, and it used to say nothing whatsoever about the
 * network the servers share.
 *
 * The three verdicts below are three different situations with three different
 * fixes, and collapsing any two of them is how this check would start being
 * ignored.
 */
describe('describeNetworkIsolation', () => {
  it('confirms a node whose servers cannot reach one another', () => {
    const check = describeNetworkIsolation('node-1', {
      network: 'hopper0',
      status: 'isolated',
      detail: 'com.docker.network.bridge.enable_icc=false',
    });

    expect(check.level).toBe('ok');
    expect(check.detail).toContain('hopper0');
  });

  /**
   * A failure, alongside a world-readable `.env` and for the same reason:
   * neither stops the panel working, both are a written guarantee being false on
   * this installation, and both are two commands away from fixed. The exit code
   * is what carries it into `install.sh && hopper doctor`.
   */
  it('fails a node whose servers can reach one another, and says where the fix is', () => {
    const check = describeNetworkIsolation('node-1', {
      network: 'hopper0',
      status: 'open',
      detail: 'com.docker.network.bridge.enable_icc is not set on it',
    });

    expect(check.level).toBe('fail');
    expect(check.detail).toContain('hopper0');
    expect(check.detail).toContain('journalctl -u hopperd');

    // No command, on purpose. Repairing means replacing the network, and
    // whether hopperd rebuilds it or refuses to start depends on
    // `docker.network.autoCreate` in that node's daemon.yml, which the panel
    // cannot see. Printing the half that fits the default takes the other half
    // of the population permanently offline.
    expect(check.detail).not.toContain('docker network rm');
  });

  /**
   * The two shapes of "we do not know", which must never be reported as "wide
   * open": a node whose Docker was not answering when it was asked, and a daemon
   * predating the check altogether. Failing either would put a red cross on
   * healthy installations at every upgrade, and a check that cries wolf is a
   * check people learn to skip past — including on the node where it is right.
   */
  it('warns rather than accusing when the node could not check', () => {
    const check = describeNetworkIsolation('node-1', {
      network: 'hopper0',
      status: 'unknown',
      detail: 'Docker did not answer when asked about it: connect ENOENT',
    });

    expect(check.level).toBe('warn');
    expect(check.detail).toContain('Docker did not answer');
  });

  it('warns, and asks for an upgrade, when the daemon does not report it', () => {
    const check = describeNetworkIsolation('node-1', undefined);

    expect(check.level).toBe('warn');
    expect(check.detail).toContain('upgrade hopperd');
  });
});
