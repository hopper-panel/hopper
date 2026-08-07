import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATALOG, catalogGroups } from './index.js';
import { templateDefinitionSchema } from './definition.js';
/**
 * Reaching into the daemon from a template test, on purpose.
 *
 * A `startup` is a string on this side of the wire and an argv on the other,
 * and the translation between them is not this package's: split on quotes,
 * substitute, and **drop whatever came out empty**. A test that re-implemented
 * that would agree with itself while the real builder disagreed, which is the
 * one thing worth testing here.
 *
 * This does not make `@hopper/templates` depend on `@hopper/daemon`, and it
 * must not become that: the import lives in a spec file that no build ever
 * reaches, and `invocation.ts` imports nothing of its own, so nothing follows
 * it in.
 */
import { buildInvocation } from '../../../apps/daemon/src/server/invocation.js';

describe('catalogue de templates', () => {
  it('holds templates', () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThan(0);
  });

  it('validates every definition', () => {
    for (const template of TEMPLATE_CATALOG) {
      expect(() => templateDefinitionSchema.parse(template)).not.toThrow();
    }
  });

  // The keys serve as upsert identifiers: a duplicate would have one template
  // overwrite another on every seed.
  it('uses unique keys', () => {
    const keys = TEMPLATE_CATALOG.map((template) => template.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares known groups', () => {
    expect(catalogGroups().length).toBeGreaterThan(0);
    for (const group of catalogGroups()) {
      expect(group.trim()).not.toBe('');
    }
  });

  describe('each template', () => {
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s is coherent',
      (_name, template) => {
        // A default image is indispensable: it is the one used when the user
        // picks none.
        expect(template.dockerImages.length).toBeGreaterThan(0);

        // An invalid detection regex would only throw when the first server
        // starts, long after the mistake.
        if (template.startupDetection) {
          expect(() => new RegExp(template.startupDetection!)).not.toThrow();
        }

        expect(template.stopCommand).toMatch(/^(command:.+|signal:SIG(TERM|INT|KILL))$/);
      },
    );
  });

  /**
   * The rule that keeps a template readable by a node nobody has upgraded.
   *
   * A daemon predating PR #59 does not know the `readiness` field, and its
   * configuration schema strips what it does not know — silently, with no
   * warning anywhere. So on that node a template declaring a strategy and no
   * `startupDetection` declares nothing at all, and its servers are called
   * running the instant their container comes up: minutes early on a modded
   * pack, and wrong on any game whose port opens late.
   *
   * That is the worst shape a mistake can take here. It cannot be seen from
   * the machine the template was written on, it appears only on the nodes that
   * cannot be upgraded in lockstep, and it looks exactly like a server that
   * started quickly. Hence a catalogue-wide check rather than a note in the
   * documentation: the invariant has to hold for the tenth template as well as
   * for the first, and nobody rereads a note.
   */
  describe('every template that declares a readiness strategy', () => {
    const withReadiness = TEMPLATE_CATALOG.filter((template) => template.readiness).map(
      (template) => [template.name, template] as const,
    );

    it.each(withReadiness)('%s still declares a startupDetection', (_name, template) => {
      expect(template.startupDetection).toBeTruthy();
    });

    it.each(withReadiness)('%s agrees with its own first pattern', (_name, template) => {
      // Only a `log` strategy can be expressed in the deprecated field at all,
      // and then only its first pattern — one string is the whole of what it
      // holds. Making them agree means an old node watches for the same line
      // the new one watches for first, rather than for something the template
      // author changed on one side and forgot on the other.
      if (template.readiness?.type !== 'log') {
        return;
      }

      expect(template.startupDetection).toBe(template.readiness.patterns[0]);
    });
  });

  describe('the first template that is not Minecraft', () => {
    const factorio = TEMPLATE_CATALOG.find((template) => template.key === 'factorio');

    it('is in the catalogue', () => {
      expect(factorio).toBeDefined();
    });

    /**
     * The reason the readiness union was built.
     *
     * `startupDetection` holds one pattern and nothing else, and a game whose
     * only marker is a line no Bukkit server prints had no way to say so. A
     * template that declared nothing here would be resolved from the
     * deprecated field alone — which still works, and is exactly the state
     * this template exists to move past.
     */
    it('declares a readiness strategy, not a bare startupDetection', () => {
      expect(factorio?.readiness).toBeDefined();
      // Not `port`: the game port is UDP, and the daemon refuses a UDP probe
      // rather than knocking on a TCP port nothing is listening on.
      expect(factorio?.readiness?.type).toBe('log');

      const patterns = factorio?.readiness?.type === 'log' ? factorio.readiness.patterns : [];

      // More than one, which is precisely what the deprecated field could not
      // have carried.
      expect(patterns.length).toBeGreaterThan(1);
      patterns.forEach((pattern) => expect(() => new RegExp(pattern)).not.toThrow());

      // And the deprecated field still travels: a node running a daemon older
      // than the union reads nothing else, and without it would call the
      // server running the moment its container came up.
      expect(factorio?.startupDetection).toBe(patterns[0]);
    });

    /**
     * The patterns against the lines they claim to match.
     *
     * A readiness pattern is only ever exercised by a running server, and one
     * that stops matching does not fail loudly: the server sits in `starting`
     * until the deadline, and a start that was fine is reported as a failure.
     *
     * The lines below are not written in the style of Factorio output, they
     * are Factorio output — copied from a 2.0.77 headless server started with
     * this template's own command, timestamps and source locations and all. A
     * sample tidied up by hand is exactly how a pattern comes to match the
     * sample and nothing else; note that the hosting line carries no `Info
     * File.cpp:NNN:` prefix while the state line does, which is the sort of
     * detail nobody invents.
     */
    const announcesReady = (line: string): boolean =>
      (factorio?.readiness?.type === 'log' ? factorio.readiness.patterns : [])
        // Exactly how the daemon compiles them: `new RegExp(source)`, no flags.
        .some((pattern) => new RegExp(pattern).test(line));

    it('matches the lines a headless Factorio prints once it is serving', () => {
      expect(announcesReady('  37.287 Hosting game at IP ADDR:({0.0.0.0:34197})')).toBe(true);

      // The rendering shipped by older builds, which is why the marker stops
      // at `ADDR` instead of reaching into the punctuation after it.
      expect(announcesReady('  37.287 Hosting game at IP ADDR:{0.0.0.0:34197}')).toBe(true);

      // The second marker, and the reason its parentheses are escaped: they
      // are part of the line, and an unescaped pattern would be matching
      // capture groups against text that has none.
      expect(
        announcesReady(
          '  37.288 Info ServerMultiplayerManager.cpp:808: updateTick(0) changing state from(CreatingGame) to(InGame)',
        ),
      ).toBe(true);
    });

    it('does not match the lines that come before it', () => {
      // The same state machine, one transition earlier — 800 milliseconds
      // before the server has a game. A pattern loose enough to take this
      // would call it ready there.
      expect(
        announcesReady(
          '  36.480 Info ServerMultiplayerManager.cpp:808: updateTick(18446744073709551615) changing state from(Ready) to(PreparedToHostGame)',
        ),
      ).toBe(false);
      expect(
        announcesReady(
          '   0.002 2026-08-06 17:02:47; Factorio 2.0.77 (build 84539, linux64, headless, space-age)',
        ),
      ).toBe(false);
      expect(
        announcesReady('  36.496 Loading map /mnt/server/saves/gamesave.zip: 874216 bytes.'),
      ).toBe(false);
      // Printed one millisecond before the hosting line, and carrying the same
      // address: `IP ADDR:` alone is not the marker.
      expect(
        announcesReady(
          '  37.287 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34197}))',
        ),
      ).toBe(false);

      // And the line every other template in this catalogue waits for, which
      // shares nothing with these.
      expect(
        announcesReady('[12:00:00] [Server thread/INFO]: Done (12.417s)! For help, type "help"'),
      ).toBe(false);
    });

    /**
     * The declaration is the half that cannot really break. This is the other
     * half: what a node actually executes.
     */
    describe('its startup command', () => {
      /**
       * What a node hands the builder for a Factorio server.
       *
       * The environment holds the template's own variables at their defaults
       * and nothing else, which is what makes the refusal below mean something:
       * anything the command references that a real server would not have stops
       * the build rather than quietly disappearing from the argv.
       *
       * One port, unnamed, because that is what this template ships with — it
       * declares no RCON, so it asks for no named port either.
       */
      const context = {
        environment: Object.fromEntries(
          (factorio?.variables ?? []).map((variable) => [
            variable.envVariable,
            variable.defaultValue,
          ]),
        ),
        // Supplied to every server whether or not the game can use them. This
        // one cannot: there is no heap to size.
        memoryMib: 4096,
        allocations: { default: { ip: '0.0.0.0', port: 34197 }, additional: [] },
      };

      it('becomes the argv the headless binary expects', () => {
        const { argv } = buildInvocation(factorio!.startup, context);

        expect(argv).toEqual([
          './bin/x64/factorio',
          // Not `--start-server saves/<name>.zip`: a named save cannot be an
          // autosave, and an autosave is all a crashed host has left.
          '--start-server-load-latest',
          '--server-settings',
          'data/server-settings.json',
          '--port',
          '34197',
        ]);
      });

      it('references no variable a running server would not have', () => {
        // A build that succeeds is the assertion: one unknown name and there
        // would be no argv at all.
        expect(() => buildInvocation(factorio!.startup, context)).not.toThrow();
      });

      it('gives every value-taking flag its value', () => {
        const { argv } = buildInvocation(factorio!.startup, context);
        const takesValue = new Set(['--server-settings', '--port']);

        argv.forEach((token, index) => {
          if (!takesValue.has(token)) {
            return;
          }

          const value = argv[index + 1];

          expect(value, `${token} was left with no value`).toBeDefined();
          expect(value, `${token} was followed by another flag`).not.toMatch(/^-/);
        });
      });

      /**
       * Why the three tests above are worth their lines — and the case they
       * were written against, kept exactly as it was.
       *
       * This used to assert the bug. A variable that did not resolve was not an
       * error: it substituted to an empty string, the argument it was alone in
       * was dropped, and `--port` was left holding whatever came next — here,
       * nothing at all. The server started under a command nobody had written,
       * and the only symptom was the game's own complaint several lines into a
       * console.
       *
       * The typo is still one letter. What changed is that it now costs a start
       * that says why, instead of a server listening on a port the template did
       * not choose.
       */
      it('refuses the start if its port variable stops resolving', () => {
        const typo = factorio!.startup.replace('{{SERVER_PORT}}', '{{SERVER_PROT}}');

        expect(() => buildInvocation(typo, context)).toThrow(/SERVER_PROT/);
      });
    });

    // The slash is the command, not decoration: Factorio's console tells a
    // command from a chat message by it, so `quit` alone is broadcast to the
    // players while the server runs on to its SIGKILL.
    it('stops with a console command, slash included', () => {
      expect(factorio?.stopCommand).toBe('command:/quit');
    });

    describe('its variable rules', () => {
      const ruleExpression = (envVariable: string): RegExp => {
        const rules =
          factorio?.variables.find((variable) => variable.envVariable === envVariable)?.rules ?? '';
        const source = /regex:\/(.*)\/$/.exec(rules)?.[1];

        expect(source, `${envVariable} declares no regex rule`).toBeDefined();

        return new RegExp(source!);
      };

      /**
       * The rule string is split on `|` **before** anything looks for `regex:`.
       *
       * An alternation inside one is therefore torn into fragments: the first
       * becomes an unterminated expression, which fails to compile, and a
       * pattern that fails to compile is treated as the template's mistake and
       * accepts every value; the remaining fragments are read as rules nobody
       * recognises and ignored. The result reads as the strictest line in the
       * file and enforces nothing at all — so the expressions here are written
       * as character classes, and this is what keeps them that way.
       */
      it('writes its regular expressions without an alternation', () => {
        for (const variable of factorio?.variables ?? []) {
          const index = variable.rules.indexOf('regex:');

          if (index === -1) {
            continue;
          }

          expect(
            variable.rules.slice(index),
            `${variable.envVariable} splits on its own rule`,
          ).not.toContain('|');
        }
      });

      // This value becomes a segment of the download URL, and curl resolves a
      // path before it sends it.
      it.each(['stable', 'experimental', 'latest', '2.0.28', '1.1.110'])(
        'accepts %s as a version',
        (value) => {
          expect(ruleExpression('FACTORIO_VERSION').test(value)).toBe(true);
        },
      );

      it.each([
        '../1.1.110',
        'stable/../../secrets',
        '..',
        '.2.0',
        '%2e%2e%2f',
        'http://elsewhere.test/x',
        'stable evil',
        '2.0.28\n../x',
        // The trailing-newline bypass, which is a real one in the languages
        // where `$` matches before a final newline. It is not in JavaScript
        // without the `m` flag, and the panel compiles these without flags —
        // this is what would notice if either half of that changed.
        '2.0.28\n',
        '1234567890123456789012',
      ])('refuses %j as a version', (value) => {
        expect(ruleExpression('FACTORIO_VERSION').test(value)).toBe(false);
      });

      // The same reasoning one variable down, where the path is the install
      // script's rather than a URL's.
      it.each(['../../etc/passwd', 'save.zip', 'a b', ''])('refuses %j as a save name', (value) => {
        expect(ruleExpression('SAVE_NAME').test(value)).toBe(false);
      });
    });
  });

  describe('install scripts', () => {
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s fails loudly',
      (_name, template) => {
        // Without `set -e`, a failing command lets the script carry on and the
        // installation is declared successful with an incomplete volume.
        expect(template.installScript).toContain('set -e');

        // Without `--fail`, curl writes an HTTP error page into the destination
        // file and returns 0. That is how the retirement of PaperMC v2 produced
        // zero-byte .jars.
        const curlCalls = template.installScript.match(/curl [^\n|]*-o /g) ?? [];
        for (const call of curlCalls) {
          expect(call).toContain('--fail');
        }
      },
    );

    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s only references declared variables',
      (_name, template) => {
        const declared = new Set([
          ...template.variables.map((variable) => variable.envVariable),
          // Supplied by Hopper to every server.
          'SERVER_MEMORY',
          'SERVER_IP',
          'SERVER_PORT',
        ]);

        // `${VAR}` in the script, `{{VAR}}` in the startup command.
        const used = [
          ...template.installScript.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g),
          ...template.startup.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g),
        ].map((match) => match[1]!);

        // The script's local variables (uppercase but assigned on the spot)
        // are skipped: only those Hopper has to supply count. A leading
        // `\s*`: an assignment inside an `if` block is indented, and strict
        // anchoring made it look like an undeclared variable.
        const assigned = new Set(
          [...template.installScript.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=/gm)].map(
            (match) => match[1]!,
          ),
        );

        const missing = used.filter((name) => !declared.has(name) && !assigned.has(name));

        expect(missing).toEqual([]);
      },
    );
  });
});
