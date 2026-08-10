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

        /**
         * Every `regex:` rule is delimited, comes last, and compiles.
         *
         * All three matter to the panel's reading of the rule string. It scans
         * a `regex:/…/` whole, so an alternation inside one is safe — but only
         * a delimited one; a bare `regex:` is still cut on the pipe, because
         * nothing can tell an alternation's pipe from the next rule's. And a
         * rule that will not compile no longer passes every value: it refuses
         * them all, so a typo shipped here would make the variable impossible
         * to set rather than merely unguarded. Last in the list is this
         * catalogue's own convention, and what `ruleExpression` below reads.
         */
        for (const variable of template.variables) {
          if (!variable.rules.includes('regex:')) {
            continue;
          }

          const delimited = /regex:\/(.*)\/([a-z]*)$/.exec(variable.rules);

          expect(
            delimited,
            `${variable.envVariable}: its regex rule is not delimited, or is not last`,
          ).not.toBeNull();
          expect(() => new RegExp(delimited?.[1] ?? '', delimited?.[2])).not.toThrow();
        }
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
  /**
   * The two templates that host somebody else's code.
   *
   * Nothing about them is a game, so none of the engine-wide checks above
   * applies. What they have instead is a pair of contracts that span two
   * strings each, and a pair is exactly what drifts: one half is edited, the
   * other is not, and the failure lands at a first start with nothing pointing
   * back at the edit.
   */
  describe('the Discord bot templates', () => {
    const python = TEMPLATE_CATALOG.find((template) => template.key === 'discord-bot-python');
    const node = TEMPLATE_CATALOG.find((template) => template.key === 'discord-bot-node');

    it('are both in the catalogue', () => {
      expect(python).toBeDefined();
      expect(node).toBeDefined();
    });

    /**
     * The half of the package contract that lives in a variable, against the
     * half that lives in the install script.
     *
     * `pip install --target` writes to the volume through `/mnt/server`; the
     * bot reads it through `/home/container`, because that is where the same
     * volume is mounted at runtime. Two strings, one directory. Moving either
     * without the other gives a bot that starts and dies on its first import.
     */
    it('point Python at the directory the install script fills', () => {
      const path = python?.variables.find((variable) => variable.envVariable === 'PYTHONPATH');

      expect(path?.defaultValue).toBe('/home/container/.python-deps');
      expect(python?.installScript).toContain('--target /mnt/server/.python-deps');
      expect(path?.defaultValue.replace('/home/container', '/mnt/server')).toBe(
        '/mnt/server/.python-deps',
      );
    });

    it('do not let an operator edit that path', () => {
      const path = python?.variables.find((variable) => variable.envVariable === 'PYTHONPATH');

      // Not a setting: it is the second half of the contract above, and the
      // panel would otherwise offer it beside the bot's own token.
      expect(path?.userEditable).toBe(false);
      expect(path?.userViewable).toBe(false);
    });

    /**
     * `-u`, whose absence is invisible until somebody opens the console.
     *
     * CPython buffers stdout in blocks whenever it is not a terminal, and the
     * console is a pipe. Without the flag a bot that logs "ready" and then
     * idles shows nothing at all — indistinguishable from one that hung.
     */
    it('run Python unbuffered', () => {
      expect(python?.startup).toContain('python -u ');
    });

    it('stop with the signal that unwinds the interpreter', () => {
      // SIGTERM kills CPython where it stands; SIGINT raises KeyboardInterrupt,
      // so `finally` runs and the gateway connection is closed rather than
      // dropped.
      expect(python?.stopCommand).toBe('signal:SIGINT');
      expect(node?.stopCommand).toBe('signal:SIGINT');
    });

    it('demand a token and ship none', () => {
      for (const template of [python, node]) {
        const token = template?.variables.find(
          (variable) => variable.envVariable === 'DISCORD_TOKEN',
        );

        expect(token?.rules).toContain('required');
        // A default here would be a credential in the repository.
        expect(token?.defaultValue).toBe('');
        expect(token?.userEditable).toBe(true);
      }
    });

    /**
     * The entry point is a path the operator types, and it reaches `python` as
     * argv. The class is what keeps `..` out of it.
     */
    it.each([
      ['../../etc/passwd', false],
      ['bot.py', true],
      ['src/main.py', true],
      ['bot.py; rm -rf /', false],
      ['', false],
    ])('reads %j as a bot file: %s', (value, accepted) => {
      const rules = python?.variables.find((variable) => variable.envVariable === 'PY_FILE')?.rules;
      const pattern = /regex:\/(.+)\/$/.exec(rules ?? '');

      expect(pattern).not.toBeNull();
      expect(new RegExp(pattern![1]!).test(value)).toBe(accepted);
    });

    /**
     * The first version of these templates created nothing, and the first
     * start of every new server said `python: can't open file
     * '/home/container/bot.py'`. Correct, useless, and answered only by a
     * paragraph in an install log nobody had a reason to open.
     */
    it('write a bot that starts, rather than leaving an empty volume', () => {
      expect(python?.installScript).toContain('discord.py>=2.4,<3');
      expect(python?.installScript).toContain('client.run(TOKEN)');
      expect(node?.installScript).toContain('"discord.js": "^14.16.3"');
      expect(node?.installScript).toContain('client.login(token)');
    });

    /**
     * The rule the Source templates already follow for `server.cfg`, and the
     * one that makes this script safe to run again: a reinstall is how a
     * dependency is added here, so it meets a volume full of the operator's
     * work every time. Writing unconditionally would delete their bot at the
     * moment they were being careful.
     */
    it('seed each file only where there is none', () => {
      for (const template of [python, node]) {
        const seeds = (template?.installScript ?? '')
          .split('\n')
          .filter((line) => line.startsWith('  cat > '));

        expect(seeds).toHaveLength(2);

        // Every heredoc is inside an `if [ ! -f … ]`, never on its own.
        const guards = (template?.installScript ?? '')
          .split('\n')
          .filter((line) => line.startsWith('if [ ! -f '));

        expect(guards).toHaveLength(2);
      }
    });

    /**
     * The scaffold seeds the file the startup command runs, not a file named
     * after it. Seeding `bot.py` while the command runs `src/main.py` would
     * leave the original error standing with something in the volume to make
     * it puzzling.
     */
    it('seed the file the startup command actually runs', () => {
      expect(python?.installScript).toContain('PY_FILE="${PY_FILE:-bot.py}"');
      expect(python?.startup).toContain('{{PY_FILE}}');
      expect(node?.installScript).toContain('MAIN_FILE="${MAIN_FILE:-index.js}"');
      expect(node?.startup).toContain('{{MAIN_FILE}}');
    });

    /**
     * A quoted heredoc, so nothing in the body is expanded on the way to disk.
     * An unquoted one would resolve `${DISCORD_TOKEN}` during the install and
     * write the token into a file the file manager displays and every backup
     * archive carries.
     */
    it('never write the token into the volume', () => {
      for (const template of [python, node]) {
        expect(template?.installScript).not.toContain('${DISCORD_TOKEN}');
        // The delimiter is quoted on every heredoc that writes a seed.
        for (const line of (template?.installScript ?? '')
          .split('\n')
          .filter((line) => line.includes('cat > '))) {
          expect(line).toMatch(/<<'[A-Z]+'$/);
        }
      }
    });

    it('claim no disk they cannot know', () => {
      // The field refuses an installation. What a dependency tree weighs is
      // whatever its author put in requirements.txt, so a figure here would
      // refuse installs that would have worked.
      expect(python?.installRequiredDiskBytes).toBeUndefined();
      expect(node?.installRequiredDiskBytes).toBeUndefined();
    });
  });

  describe('every template that declares a readiness strategy', () => {
    const withReadiness = TEMPLATE_CATALOG.filter((template) => template.readiness).map(
      (template) => [template.name, template] as const,
    );

    /**
     * Every strategy except the one an old daemon already implements.
     *
     * The fallback a missing `startupDetection` leaves behind is "running as
     * soon as the container is", which is not a degradation of `immediate` —
     * it *is* `immediate`. A template that declares it and nothing else
     * therefore behaves identically on a node that has never heard of the
     * readiness union and on one that has, and demanding a console pattern
     * from it would mean inventing a line the process is not known to print.
     *
     * The combination is not new here either: the egg importer emits exactly
     * it for the eggs that declare no marker at all. What is new is a shipped
     * template doing so, which is what turned the rule from "always" into
     * "wherever the two answers differ".
     */
    it.each(withReadiness.filter(([, template]) => template.readiness?.type !== 'immediate'))(
      '%s still declares a startupDetection',
      (_name, template) => {
        expect(template.startupDetection).toBeTruthy();
      },
    );

    it.each(withReadiness.filter(([, template]) => template.readiness?.type === 'immediate'))(
      '%s declares no console pattern, because there is none to declare',
      (_name, template) => {
        // Asserted rather than merely skipped: a pattern appearing here later
        // would mean the template had grown an opinion the strategy contradicts.
        expect(template.startupDetection).toBeUndefined();
      },
    );

    // A pattern is only ever exercised by a running server, and a broken one
    // does not fail loudly: the server sits in `starting` until its deadline
    // expires — or for ever, where the template declared none.
    it.each(withReadiness)('%s declares patterns that compile', (_name, template) => {
      if (template.readiness?.type !== 'log') {
        return;
      }

      for (const pattern of template.readiness.patterns) {
        // Exactly how the daemon compiles them: `new RegExp(source)`, no flags.
        expect(() => new RegExp(pattern), pattern).not.toThrow();
      }
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
     * The stop, which is where this game differs from every other template
     * here by more than a string.
     *
     * Factorio serialises its **whole world** on a clean exit and rewrites the
     * save it was loaded from; a kill landing inside that write is the one way
     * this stop loses data, and `--start-server-load-latest` then comes back on
     * an autosave instead. The contract's thirty seconds is a Bukkit figure —
     * regions flushed in a second or two — and it was the only figure available
     * until a template could name its own.
     */
    it('gives its shutdown far longer than the Minecraft default', () => {
      expect(factorio?.stopTimeoutSeconds).toBeGreaterThan(30);
      // Inside the ceiling the contract puts on a stop: past ten minutes an
      // operator cannot tell a server that is saving from one that has hung.
      expect(factorio?.stopTimeoutSeconds).toBeLessThanOrEqual(600);
    });

    it('still stops over standard input, which this game does read', () => {
      // Deliberately not the RCON transport, which exists for the games that
      // read no stdin at all. Factorio does, and the leading slash is what
      // tells its console a command from a chat message.
      expect(factorio?.stop).toBeUndefined();
      expect(factorio?.stopCommand).toBe('command:/quit');
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

  /**
   * The first template installed from Steam, and the first on the Source engine.
   *
   * Everything asserted below is something no test in this repository can
   * observe by running: there is no Garry's Mod here, no SteamCMD, and no six
   * and a half gigabytes to download. What these tests hold in place is the set
   * of decisions whose consequences are invisible until they are expensive — a
   * missing `-norestart` that turns every stop into a kill, a `+force_install_dir`
   * that arrived too late and installed into a container layer, an install
   * script that quietly deleted the operator's configuration on the reinstall
   * they ran to *update* the server.
   *
   * The decisions themselves were checked outside the suite, which is where the
   * figures and console lines quoted below come from: the depot really was
   * installed, the server really was started on the runtime image and stopped
   * with `quit`, and four of the claims these tests were first written around
   * did not survive it: `su`, the `server.cfg` guard, the `sdk64` copy and the
   * disk figure. Each is named where it used to be asserted.
   */
  describe('the first template installed from SteamCMD', () => {
    const garrysMod = TEMPLATE_CATALOG.find((template) => template.key === 'garrys-mod');

    it('is in the catalogue', () => {
      expect(garrysMod).toBeDefined();
    });

    /**
     * It used to share Factorio's group, and this test used to say so.
     *
     * The reasoning then was that "Other games" had been named for the category
     * precisely so a second non-Minecraft template would need no new group —
     * true, and it stopped being the right call once the engine had two
     * templates of its own. `srcds_run`, `-norestart`, the console on standard
     * input, the anonymous depot and the Steam-login marker are shared by every
     * game here and by none of Factorio's; that is a family, not a one-entry
     * section.
     *
     * A group name is the upsert key, so this move is what a resynchronisation
     * performs on an existing installation: the group is created, the templates
     * are moved into it, and "Other games" keeps Factorio.
     */
    it('is in a group named for the engine, which Factorio is not in', () => {
      const factorio = TEMPLATE_CATALOG.find((template) => template.key === 'factorio');

      expect(garrysMod?.group).toBe('Source engine');
      expect(factorio?.group).not.toBe(garrysMod?.group);
    });

    /**
     * Everything the engine decides, asserted across every game on it.
     *
     * These four are the ones a new Source template is most likely to get wrong
     * by writing them out again instead of sharing them, and each has a failure
     * that does not look like its cause: without `-norestart` every stop is a
     * SIGKILL thirty seconds after a server that already restarted; without
     * `+force_install_dir` the depot lands in a container layer and the volume
     * comes up empty; a stop over anything but standard input needs a password
     * this template has nowhere to keep.
     */
    describe.each(
      TEMPLATE_CATALOG.filter((template) => template.group === 'Source engine').map(
        (template) => [template.name, template] as const,
      ),
    )('%s, on the shared engine', (_name, template) => {
      it('stops by typing quit on the console', () => {
        expect(template.stopCommand).toBe('command:quit');
      });

      it('passes -norestart, without which every stop is a kill', () => {
        expect(template.startup).toContain('-norestart');
      });

      it('installs into the volume rather than into the container', () => {
        expect(template.installScript).toContain('+force_install_dir /mnt/server');
        expect(template.installScript).toContain('validate');
      });

      it('waits for the Steam login rather than for the container', () => {
        expect(template.readiness?.type).toBe('log');
        expect(template.startupDetection).toBe('gameserver Steam ID');
      });

      it('asks for twice what its depot unpacks to', () => {
        // The figure is a refusal, so it is checked for being present and large
        // rather than for a value: an install allowed onto a node that cannot
        // hold it fills the disk for every server on the machine.
        expect(template.installRequiredDiskBytes ?? 0).toBeGreaterThan(6 * 1024 ** 3);
      });
    });

    /**
     * The readiness patterns against the lines they claim to match.
     *
     * Like Factorio's, and unlike what this comment first claimed, the console
     * lines below are copied from a run: app 4020 was installed by this
     * template's own script and started on the runtime image, and it printed
     * `Assigned anonymous gameserver Steam ID [A-1:857537543(50865)].` and
     * `VAC secure mode is activated.` — both patterns, in that order, with the
     * `Connection to Steam servers successful.` and `Public IP is …` lines
     * immediately in front of them. No *test* here can do that, which is why
     * the strings are pinned rather than produced.
     *
     * What they are for is the boundary: which lines mean serving, and which of
     * the lines around them a well-meaning loosening of a pattern would start
     * taking.
     */
    describe('its readiness', () => {
      const announcesReady = (line: string): boolean =>
        (garrysMod?.readiness?.type === 'log' ? garrysMod.readiness.patterns : []).some((pattern) =>
          new RegExp(pattern).test(line),
        );

      it('waits on the console, which is the only channel that can answer', () => {
        // Not `port`: the game and its A2S queries are UDP, and the daemon
        // refuses a UDP probe rather than knocking on a TCP port nothing is
        // listening on. Not `rcon` either — that needs the password this
        // template deliberately does not ship.
        expect(garrysMod?.readiness?.type).toBe('log');

        const patterns = garrysMod?.readiness?.type === 'log' ? garrysMod.readiness.patterns : [];

        expect(patterns.length).toBeGreaterThan(1);
        expect(garrysMod?.startupDetection).toBe(patterns[0]);
      });

      it('opts into a start that is allowed to fail', () => {
        // No default exists: a template that names no deadline leaves a failed
        // start spinning for ever.
        const timeout = garrysMod?.readiness?.type === 'log' ? garrysMod.readiness.timeoutMs : 0;

        expect(timeout).toBeGreaterThan(0);
        // The contract's own ceiling. Past an hour a deadline is not one.
        expect(timeout).toBeLessThanOrEqual(3_600_000);
      });

      it('matches the lines srcds prints once its game server has logged in', () => {
        expect(
          announcesReady('Assigned anonymous gameserver Steam ID [A-1:1234567890(9876)].'),
        ).toBe(true);

        // The same line with a login token configured, which this template does
        // not ship and an operator may one day be given a way to add. The marker
        // stops before the word that differs for exactly this reason.
        expect(
          announcesReady('Assigned persistent gameserver Steam ID [A-1:1234567890(9876)].'),
        ).toBe(true);

        // The second pattern, printed immediately after the login.
        expect(announcesReady('VAC secure mode is activated.')).toBe(true);
      });

      it('does not match the lines around it', () => {
        // The line that looks most like an announcement and is not one: it
        // reports how the socket was configured, not that a level has loaded.
        // It was considered as a marker and passed over for the Steam login,
        // which cannot happen before there is a game server to register.
        expect(
          announcesReady('Network: IP 0.0.0.0, mode MP, dedicated Yes, ports 27015 SV / 27005 CL'),
        ).toBe(false);
        expect(announcesReady('Setting breakpad minidump AppID = 4000')).toBe(false);
        expect(announcesReady('maxplayers set to 16')).toBe(false);

        // The neighbours of the marker, from the same login. Close enough that
        // a pattern reaching for the word "Steam" would take them, and what
        // they report is a connection to Steam rather than this server having
        // been given an identity on it.
        expect(announcesReady('Connection to Steam servers successful.')).toBe(false);
        expect(announcesReady('   Public IP is 203.0.113.7.')).toBe(false);

        // And the lines the rest of this catalogue waits for, which share
        // nothing with these.
        expect(
          announcesReady('[12:00:00] [Server thread/INFO]: Done (12.417s)! For help, type "help"'),
        ).toBe(false);
        expect(announcesReady('  37.287 Hosting game at IP ADDR:({0.0.0.0:34197})')).toBe(false);
      });
    });

    describe('its stop', () => {
      it('goes down standard input, which a Source server does read', () => {
        // The correction this template was written around: `docs/templates.md`
        // and the contract both listed Source among the games that read no
        // stdin, and sent them to RCON on the strength of it. srcds reads its
        // console from stdin, so the transport it already had is the right one
        // — no password, no port, no fresh ways to be refused.
        expect(garrysMod?.stop).toBeUndefined();
        expect(garrysMod?.stopCommand).toBe('command:quit');
      });

      it("keeps the contract stop timeout rather than borrowing Factorio's", () => {
        // Absent on purpose. Factorio's four minutes buy a world being
        // serialised; a Source server writes nothing on the way out, so there
        // is nothing for a timeout to cut in half. Saying nothing is how a
        // template asks for the contract's thirty seconds, and the assertion is
        // here so that a number appearing later is a decision somebody made.
        expect(garrysMod?.stopTimeoutSeconds).toBeUndefined();
      });
    });

    describe('its startup command', () => {
      /**
       * What a node hands the builder for a Garry's Mod server: the template's
       * own variables at their defaults, and one unnamed port.
       */
      const context = {
        environment: Object.fromEntries(
          (garrysMod?.variables ?? []).map((variable) => [
            variable.envVariable,
            variable.defaultValue,
          ]),
        ),
        // Supplied to every server whether or not the game can use it. This one
        // cannot: there is no heap to size.
        memoryMib: 4096,
        allocations: { default: { ip: '0.0.0.0', port: 27015 }, additional: [] },
      };

      it('becomes the argv srcds expects', () => {
        const { argv } = buildInvocation(garrysMod!.startup, context);

        expect(argv).toEqual([
          './srcds_run',
          '-game',
          'garrysmod',
          '-console',
          '-norestart',
          '-port',
          '27015',
          // Before `+map`, because `map` is the command that loads the level and
          // starts the server: what follows it lands on a server already up.
          '+maxplayers',
          '16',
          '+gamemode',
          'sandbox',
          '+map',
          'gm_construct',
        ]);
      });

      /**
       * The one flag whose absence costs a kill, every time.
       *
       * `srcds_run` is a wrapper that relaunches the server whenever it exits.
       * Hopper waits for the **container** to go down, and the container is the
       * wrapper — so without this the `quit` above is delivered, obeyed and
       * answered with a fresh server, `stopTimeoutSeconds` expires, and the
       * SIGKILL lands on a replacement that has been taking players since the
       * stop began. Asserted on the built argv rather than on the template
       * string, because what matters is that it survives into what runs.
       */
      it('passes -norestart, without which every stop is a kill at the timeout', () => {
        expect(buildInvocation(garrysMod!.startup, context).argv).toContain('-norestart');
      });

      it('gives every value-taking flag its value', () => {
        const { argv } = buildInvocation(garrysMod!.startup, context);
        const takesValue = new Set(['-game', '-port', '+maxplayers', '+gamemode', '+map']);

        argv.forEach((token, index) => {
          if (!takesValue.has(token)) {
            return;
          }

          const value = argv[index + 1];

          expect(value, `${token} was left with no value`).toBeDefined();
          expect(value, `${token} was followed by another flag`).not.toMatch(/^[-+]/);
        });
      });

      it('references no variable a running server would not have', () => {
        expect(() => buildInvocation(garrysMod!.startup, context)).not.toThrow();
      });

      it('refuses the start if its port variable stops resolving', () => {
        const typo = garrysMod!.startup.replace('{{SERVER_PORT}}', '{{SERVER_PROT}}');

        expect(() => buildInvocation(typo, context)).toThrow(/SERVER_PROT/);
      });

      /**
       * Why every variable here is `required` with a default that is not empty.
       *
       * A variable that is *defined and empty* is not an error: its argument is
       * dropped, silently as far as the argv is concerned, and the flag in front
       * of it takes the next one. `+map` would then be handed nothing and the
       * server would start on a map nobody chose — which is the failure the
       * builder deliberately cannot fix on its own, since it cannot know which
       * flags take a value.
       */
      it('leaves no flag able to be stranded by an empty value', () => {
        for (const variable of garrysMod?.variables ?? []) {
          expect(variable.rules, variable.envVariable).toContain('required');
          expect(variable.defaultValue, variable.envVariable).not.toBe('');
        }
      });

      it('is what every variable it declares is for', () => {
        // A variable the command never reads is a field an operator can change
        // to no effect, which is worse than not offering it.
        for (const variable of garrysMod?.variables ?? []) {
          expect(garrysMod!.startup, variable.envVariable).toContain(`{{${variable.envVariable}}}`);
        }
      });
    });

    describe('its install script', () => {
      const script = garrysMod?.installScript ?? '';

      /**
       * What the shell will actually run, which is not what `installScript`
       * contains.
       *
       * Every assertion below searches for command text, and this script's
       * comments quote that same text — one line reads `# +login anonymous: app
       * 4020 is the public Garry's Mod dedicated server and`, another names
       * `+app_update 4020 validate` while recounting what was measured. Search
       * the whole script and a comment answers. Measured, not reasoned: with the
       * steamcmd line mutated to `+app_update 4000` — the wrong game entirely,
       * downloading something with no `garrysmod/` in it — the suite stayed
       * green, and so it did for dropping `validate` and for dropping `+login
       * anonymous`. All three are killed against this.
       */
      const executable = script
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');

      /**
       * The line that decides whether six gigabytes land in the volume.
       *
       * SteamCMD applies `force_install_dir` to the commands that follow it and
       * not to the ones already run. Named after `app_update`, or not at all,
       * the depot goes into a directory on the install container's own
       * filesystem — deleted seconds later — and the script still exits 0. The
       * server then starts on an empty volume, and the disk preflight will have
       * checked a filesystem the download never touched.
       */
      it('names the install directory before the download that uses it', () => {
        const forced = executable.indexOf('+force_install_dir /mnt/server');
        const update = executable.indexOf('+app_update 4020');

        expect(forced, 'no +force_install_dir /mnt/server').toBeGreaterThan(-1);
        expect(update, 'no +app_update 4020').toBeGreaterThan(-1);
        expect(forced).toBeLessThan(update);
      });

      it('validates, which is what makes a reinstall a repair', () => {
        // The whole update mechanism for this server: there is no SteamCMD in
        // the runtime image, so reinstalling is how the game is brought up to
        // date, and `validate` is what re-downloads only what no longer matches
        // the manifest.
        expect(executable).toContain('+app_update 4020 validate');
      });

      it('logs in anonymously, holding no credential', () => {
        expect(executable).toContain('+login anonymous');
      });

      /**
       * Where srcds looks for the Steam client library **second**.
       *
       * `HOME` is `/home/container` in the runtime image and the volume is
       * mounted there, so this path is `~/.steam/sdk32` as the server resolves
       * it. What it is not is a requirement: app 4020 ships its own
       * `steamclient.so` at the install root and `srcds_run` puts `.` first on
       * `LD_LIBRARY_PATH`, so with `/mnt/server/.steam` masked out entirely the
       * server still logs in, is assigned its gameserver Steam ID and turns VAC
       * on. Mask the depot's copy instead and srcds says what this line is for,
       * in as many words: `Loaded '/home/container/.steam/sdk32/steamclient.so'
       * OK. (First tried local 'steamclient.so')`.
       *
       * No `sdk64` beside it, and the assertion is here so that one does not
       * quietly come back: `srcds_run`'s `detectcpu()` has no 64-bit branch on
       * Linux, so this template can only start the 32-bit binary, and the copy
       * would be 44 MiB of the operator's volume on a path nothing takes.
       */
      it('puts steamclient.so where the server looks when its own copy fails', () => {
        expect(executable).toContain('/mnt/server/.steam/sdk32/steamclient.so');

        // Comments are out of the way already, which is what lets this assert an
        // absence: saying why sdk64 is not written is exactly what the script
        // ought to be doing.
        expect(executable, 'a copy on a path this template cannot start').not.toContain('sdk64');
      });

      /**
       * Idempotence, which for a Steam server is not a nicety — and the guard
       * that has to be about content rather than existence.
       *
       * Reinstalling is the only way to update this game, so this script runs
       * over a volume full of the operator's work every time they keep their
       * server current. The published egg truncates `garrysmod/cfg/server.cfg`
       * on every run; here the write is behind a test of what is in it.
       *
       * Testing for the *file* is what this used to assert, and it made the
       * whole block dead: the depot ships `garrysmod/cfg/server.cfg`, four bytes
       * of line endings, so a fresh install already had one and took the
       * "keeping the existing" branch every time. The `grep` is what tells that
       * placeholder from a file somebody has written in, so both halves are
       * asserted — the emptiness test, and the write after it.
       */
      it('seeds the operator config only where there is nothing in it', () => {
        const guard = executable.indexOf('if [ -f "${SERVER_CFG}" ] && grep -q "[^[:space:]]"');
        const write = executable.indexOf('cat > "${SERVER_CFG}"');

        expect(guard, 'server.cfg is written without testing its content first').toBeGreaterThan(
          -1,
        );
        expect(write).toBeGreaterThan(guard);
      });

      it('removes nothing from the volume', () => {
        // `garrysmod/addons`, `garrysmod/cfg` and everything uploaded are the
        // operator's, and `app_update` leaves files it does not own alone. The
        // only way they can be lost is this script deleting them.
        const removals = [...script.matchAll(/^\s*rm\s.*$/gm)].map((match) => match[0]);

        for (const removal of removals) {
          expect(removal, 'an install script that deletes inside the volume').not.toContain(
            '/mnt/server',
          );
        }
      });
    });

    describe('its variable rules', () => {
      const rulesOf = (envVariable: string): string =>
        garrysMod?.variables.find((variable) => variable.envVariable === envVariable)?.rules ?? '';

      const ruleExpression = (envVariable: string): RegExp => {
        const source = /regex:\/(.*)\/$/.exec(rulesOf(envVariable))?.[1];

        expect(source, `${envVariable} declares no regex rule`).toBeDefined();

        return new RegExp(source!);
      };

      // The value becomes `garrysmod/maps/<value>.bsp`, so it is a path segment
      // before it is anything else.
      it.each(['gm_construct', 'gm_flatgrass', 'de_dust2', 'rp_downtown_v4c_v2'])(
        'accepts %s as a map',
        (value) => {
          expect(ruleExpression('SRCDS_MAP').test(value)).toBe(true);
        },
      );

      it.each([
        '../../etc/passwd',
        'maps/gm_construct',
        '..',
        'gm_construct.bsp',
        'gm construct',
        '',
        // The trailing-newline bypass, which is real in the languages where `$`
        // matches before a final newline. It is not in JavaScript without the
        // `m` flag, and the panel compiles these without flags.
        'gm_construct\n',
      ])('refuses %j as a map', (value) => {
        expect(ruleExpression('SRCDS_MAP').test(value)).toBe(false);
      });

      // A directory name under `garrysmod/gamemodes`, and upper case is admitted
      // because a gamemode's folder is whatever its author called it.
      it.each(['sandbox', 'terrortown', 'DarkRP'])('accepts %s as a gamemode', (value) => {
        expect(ruleExpression('GAMEMODE').test(value)).toBe(true);
      });

      it.each([
        '../sandbox',
        'sandbox/../..',
        'sand box',
        '',
        'sandbox;quit',
        // A separator and nothing else objectionable. Every other case here is
        // refused by a dot, a space or a semicolon as well, so none of them can
        // tell whether `/` is still excluded: loosening the class to
        // `[A-Za-z0-9_/-]` survived the whole suite until this line existed,
        // while the same mutation on the map rule was killed by
        // `maps/gm_construct`.
        'gamemodes/sandbox',
      ])('refuses %j as a gamemode', (value) => {
        expect(ruleExpression('GAMEMODE').test(value)).toBe(false);
      });

      it('bounds the player limit at the engine ceiling', () => {
        expect(rulesOf('MAX_PLAYERS')).toContain('min:1');
        expect(rulesOf('MAX_PLAYERS')).toContain('max:128');
      });

      it.each(['1', '16', '128'])('accepts %s as a player limit', (value) => {
        expect(ruleExpression('MAX_PLAYERS').test(value)).toBe(true);
      });

      /**
       * Digits, and the spelling matters as much as the value.
       *
       * `integer` is satisfied by anything `Number()` reads as a whole number,
       * so `1e2` and `20.0` pass it — and the string, not the number, is what
       * becomes the argv token the engine's own parser then makes what it likes
       * of. The expression is what removes the question.
       */
      it.each(['1e2', '20.0', ' 20 ', '-1', '12x', ''])('refuses %j as a player limit', (value) => {
        expect(ruleExpression('MAX_PLAYERS').test(value)).toBe(false);
      });
    });

    /**
     * The figure the disk preflight refuses installations on.
     *
     * It has to allow for the **peak** rather than the final size: SteamCMD
     * stages a depot into `steamapps/downloading` inside `force_install_dir`, so
     * the chunks and the files they become are on the same filesystem at once.
     * Being under does not fail this server — it fills the node's disk, and that
     * takes down every server on the machine.
     *
     * The bounds below are the interesting part. The installed tree measures
     * 6 919 647 587 bytes by `du -sb --apparent-size`, and Steam's rule of thumb
     * for an install is twice the unpacked size, so anything at or under that
     * doubling is a figure that has stopped following its own reasoning — which
     * is exactly what 12 GiB was.
     */
    it('declares the disk its download peaks at, not the disk it settles on', () => {
      const declared = garrysMod?.installRequiredDiskBytes ?? 0;

      // Twice the measured tree, in bytes rather than in a rounded gibibyte, so
      // that trimming the figure back under Steam's own rule fails here. The
      // measurement is the one in `source.ts`, and it has to stay that one:
      // a bound taken from a bigger tree than the script produces would fail
      // against a figure that is correct.
      expect(declared).toBeGreaterThanOrEqual(2 * 6_919_647_587);
      // And not a figure that refuses nodes which would have installed it
      // perfectly well. The preflight counts what the volume already holds
      // towards this, so a reinstall does not need it free twice over.
      expect(declared).toBeLessThan(32 * 1024 ** 3);
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

    /**
     * A portability rule, and **not** the rule this test was written for.
     *
     * It was written to enforce a claim that turned out to be false: that `su`
     * cannot work in the install container because `AUDIT_WRITE` is dropped and
     * PAM needs it to open a session. Run with exactly the capability set the
     * daemon grants — `CapDrop: ALL` plus the seven of `INSTALL_CAPABILITIES`,
     * `CapEff` `00000000000000fb` — `su steam -c "…"` returns 0. The assertion
     * message said something untrue on every failure it could ever have
     * produced.
     *
     * What survives the correction is thinner but real. That measurement was
     * taken on one kernel, WSL2's, with the audit subsystem compiled in and
     * nothing collecting; a node running `auditd` may refuse the login record
     * for want of the capability, and whether `su` then fails has not been
     * tested. A shipped template runs on every node there is and cannot see
     * which kind it landed on, whereas `runuser -u steam --` and
     * `setpriv --reuid=… --regid=… --` need only the granted `SETUID` and
     * `SETGID` and so cannot depend on it at all.
     *
     * The rule costs this catalogue nothing to keep — nothing in it wants
     * another uid, and of the 104 SteamCMD eggs among the 274 published install
     * scripts read, not one runs `su` either. `docs/templates.md` carries the
     * correction in full.
     *
     * Comment lines are skipped, because explaining why `su` is absent is
     * exactly the thing a template ought to do.
     */
    it.each(TEMPLATE_CATALOG.map((template) => [template.name, template] as const))(
      '%s does not switch user with su',
      (_name, template) => {
        const executable = template.installScript
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('#'));

        for (const line of executable) {
          expect(
            line,
            'su behaves differently depending on the node\'s audit configuration; use "runuser -u" or "setpriv"',
          ).not.toMatch(/(^|[\s;&|(])su\s/);
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
