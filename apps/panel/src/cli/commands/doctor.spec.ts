import { describe, expect, it } from 'vitest';
import { describeDockerProbe } from './doctor.js';

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
