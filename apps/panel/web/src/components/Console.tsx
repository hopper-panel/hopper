import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n';
import type { ConsoleController } from '../lib/use-console';

/**
 * Nombre de lignes conservées dans le terminal.
 *
 * Un serveur bavard produit plusieurs milliers de lignes par minute au
 * démarrage. Au-delà de cette limite, xterm.js garde tout en mémoire et
 * l'onglet finit par ramer.
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
   * `getHistory` est stable, mais `controller` change d'identité à chaque rendu.
   * Le passer par une ref évite de l'ajouter aux dépendances de l'effet de
   * création, qui détruirait et recréerait le terminal en boucle.
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

    // La connexion vit dans la mise en page du serveur et survit aux
    // changements d'onglet ; ce terminal, lui, est détruit puis recréé. Le
    // daemon ne rejoue son tampon qu'à l'authentification, qui n'a pas lieu de
    // nouveau : sans ce rejeu, revenir sur la console après un détour par les
    // fichiers afficherait un écran vide sur un serveur qui n'a jamais cessé
    // de parler.
    for (const line of getHistoryRef.current()) {
      terminal.writeln(line);
    }

    // Le terminal doit suivre le redimensionnement de la fenêtre comme celui de
    // son conteneur : replier la barre latérale change sa largeur sans qu'aucun
    // événement `resize` ne soit émis.
    //
    // `fit()` modifie la taille du terminal, donc celle de l'élément observé,
    // donc redéclenche l'observateur. Sans comparer les dimensions proposées à
    // celles en vigueur, chaque passage ajoute une ligne et la console grandit
    // sans fin. On sort donc de la boucle dès que la taille n'a plus à changer.
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
          // `proposeDimensions` lève si l'élément est masqué (onglet en
          // arrière-plan, panneau replié).
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

  /** Flèches haut/bas pour naviguer dans l'historique, comme dans un shell. */
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

  return (
    // Terminal et invite dans un même cadre, comme un vrai terminal : la ligne
    // de saisie appartient à la console, et non à la page qui l'entoure.
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-[#14161c]">
      {/* Hauteur explicite, et non `flex-1` : xterm dimensionne son contenu à
          partir de la boîte qu'on lui donne. Avec une hauteur déduite du
          contenu, chaque ligne écrite agrandissait la boîte, qui autorisait une
          ligne de plus — la console s'étendait indéfiniment vers le bas. */}
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
          placeholder={
            canSendCommand ? t('console.commandPlaceholder') : t('console.commandDenied')
          }
          disabled={!canType}
          className="w-full bg-transparent font-mono text-sm text-content placeholder:text-content-subtle focus:outline-none disabled:cursor-not-allowed"
          aria-label={t('console.commandLabel')}
        />
      </form>
    </div>
  );
}
