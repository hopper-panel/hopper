import type { Permission } from '@hopper/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useTranslation, type MessageKey } from '../i18n';
import type { ConnectionStatus, ConsoleController } from '../lib/use-console';

/**
 * Number of lines kept in the terminal.
 *
 * A talkative server produces several thousand lines a minute at startup. Past
 * this limit, xterm.js keeps everything in memory and the tab ends up crawling.
 */
const SCROLLBACK = 5000;

const THEME = {
  background: '#14161c',
  foreground: '#eceef2',
  cursor: '#f0b429',
  selectionBackground: '#3a3f4b',
};

export function Console({ controller }: { controller: ConsoleController }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const canSendCommand = controller.permissions.includes('control.console');

  /**
   * `getHistory` is stable, but `controller` changes identity on every render.
   * Passing it through a ref avoids adding it to the creation effect's
   * dependencies, which would destroy and recreate the terminal in a loop.
   */
  const getHistoryRef = useRef(controller.getHistory);
  getHistoryRef.current = controller.getHistory;

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      scrollback: SCROLLBACK,
      fontSize: 13,
      fontFamily: "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
      theme: THEME,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();

    terminalRef.current = terminal;

    // The connection lives in the server layout and survives tab changes; this
    // terminal is destroyed then recreated. The daemon only replays its buffer
    // on authentication, which does not happen again: without this replay,
    // coming back to the console after a detour through the files would show an
    // empty screen on a server that never stopped talking.
    for (const line of getHistoryRef.current()) {
      terminal.writeln(line);
    }

    // The terminal has to follow the window being resized as well as its
    // container: folding the sidebar changes its width without any `resize`
    // event being emitted.
    //
    // `fit()` changes the terminal's size, so the observed element's size, so it
    // retriggers the observer. Without comparing the proposed dimensions to the
    // current ones, every pass adds a line and the console grows without end. So
    // the loop exits as soon as the size no longer has to change.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          const proposed = fit.proposeDimensions();

          if (
            !proposed ||
            !Number.isFinite(proposed.cols) ||
            !Number.isFinite(proposed.rows) ||
            (proposed.cols === terminal.cols && proposed.rows === terminal.rows)
          ) {
            return;
          }

          terminal.resize(proposed.cols, proposed.rows);
        } catch {
          // `proposeDimensions` throws if the element is hidden (background
          // tab, folded panel).
        }
      });
    });
    observer.observe(containerRef.current);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    controller.onLine((line) => terminalRef.current?.writeln(line));
  }, [controller]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();

    const trimmed = command.trim();
    if (trimmed === '') {
      return;
    }

    controller.sendCommand(trimmed);
    setHistory((previous) =>
      [trimmed, ...previous.filter((entry) => entry !== trimmed)].slice(0, 50),
    );
    setHistoryIndex(-1);
    setCommand('');
  }

  /** Up/down arrows to walk the history, as in a shell. */
  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      if (next >= 0 && history[next] !== undefined) {
        setHistoryIndex(next);
        setCommand(history[next]);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next < 0 ? '' : (history[next] ?? ''));
    }
  }

  const canType = canSendCommand && controller.status === 'connected';

  const placeholder = t(consolePlaceholder(controller), { reason: controller.failure ?? '' });

  return (
    // Terminal and prompt in one frame, like a real terminal: the input line
    // belongs to the console, not to the page around it.
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-[#14161c]">
      {/* An explicit height, not `flex-1`: xterm sizes its content from the
          box it is given. With a height derived from the content, every line
          written grew the box, which allowed one more line — the console
          extended downwards without end. */}
      <div ref={containerRef} className="h-[58vh] min-h-72 overflow-hidden p-3" />

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t border-border-subtle px-3 py-2.5"
      >
        <span aria-hidden className="font-mono text-sm text-accent">
          »
        </span>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={!canType}
          className="w-full bg-transparent font-mono text-sm text-content placeholder:text-content-subtle focus:outline-none disabled:cursor-not-allowed"
          aria-label={t('console.commandLabel')}
        />
      </form>
    </div>
  );
}

/**
 * Which of four things the command box should say.
 *
 * They had one message between them, and it was the wrong one three times out
 * of four. `permissions` arrives with the socket's `auth_success`, so a console
 * that never connected has none — and the box said "you do not have permission
 * to send commands", a sentence about the reader's account. It sent an operator
 * hunting through their own permissions for a fault that was a node refusing an
 * origin, and it said the same thing during the second a connection takes.
 *
 * So the refusal is claimed only where it is one: a connected socket that did
 * not grant `control.console`. A connection the far end refused outright shows
 * what the far end said, because that reason — "Origin not allowed." — is the
 * single piece of information that ends the problem.
 *
 * A pure function, and separate from the component, because the component
 * needs a terminal and this needs four values.
 */
export function consolePlaceholder(controller: {
  status: ConnectionStatus;
  permissions: readonly Permission[];
  failure: string | null;
}): MessageKey {
  if (controller.status === 'failed') {
    return controller.failure ? 'console.refused' : 'console.disconnected';
  }

  if (controller.status !== 'connected') {
    return 'console.connecting';
  }

  return controller.permissions.includes('control.console')
    ? 'console.commandPlaceholder'
    : 'console.commandDenied';
}
