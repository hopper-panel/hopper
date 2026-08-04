import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PowerAction, ResourceUsage, ServerConfiguration, ServerState } from '@hopper/shared';
import type Dockerode from 'dockerode';
import type { Duplex } from 'node:stream';
import type { DockerClient } from '../docker/client.js';
import { buildContainerOptions, containerNameFor } from '../docker/container-config.js';
import type { Logger } from '../logger.js';
import type { PanelClient } from '../panel/panel-client.js';
import { ConsoleBuffer, LineAssembler } from './console-buffer.js';
import { directorySize } from './disk-usage.js';
import { runInstallation } from './installer.js';
import { buildResourceUsage, emptyUsage, type DockerStats } from './stats.js';

/** Intervalle minimal entre deux parcours du volume, en millisecondes. */
const DISK_MEASURE_INTERVAL_MS = 60_000;

export interface ServerInstanceEvents {
  state: (state: ServerState) => void;
  console: (line: string) => void;
  stats: (usage: ResourceUsage) => void;
  install_started: () => void;
  install_output: (line: string) => void;
  install_completed: (successful: boolean) => void;
}

/**
 * Événements typés.
 *
 * `EventEmitter` accepte n'importe quel nom d'événement avec n'importe quels
 * arguments : une faute de frappe dans `on('stat', …)` passerait la compilation
 * et le tableau de bord resterait vide sans erreur. Cette surcharge rend les
 * trois événements du serveur vérifiables.
 *
 * La fusion déclaration/classe est le seul moyen d'y parvenir avec
 * `EventEmitter` ; elle est sûre ici parce que l'interface ne fait que
 * restreindre des méthodes déjà présentes sur la classe de base.
 */
/* eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging */
export declare interface ServerInstance {
  on<K extends keyof ServerInstanceEvents>(event: K, listener: ServerInstanceEvents[K]): this;
  off<K extends keyof ServerInstanceEvents>(event: K, listener: ServerInstanceEvents[K]): this;
  emit<K extends keyof ServerInstanceEvents>(
    event: K,
    ...args: Parameters<ServerInstanceEvents[K]>
  ): boolean;
}

export interface ServerInstanceOptions {
  configuration: ServerConfiguration;
  docker: DockerClient;
  logger: Logger;
  volumesRoot: string;
  networkName: string;
  ownership: { uid: number; gid: number };
  timezone: string;
  enableBlkioWeight: boolean;
  /** Répertoire temporaire, où le script d'installation est déposé. */
  tmpPath: string;
  panel: PanelClient;
}

/**
 * Un serveur Minecraft, vu par le daemon.
 *
 * Porte l'état, le conteneur, le flux de console et les relevés de ressources.
 * Toute la logique d'ordonnancement (ne pas démarrer deux fois, attendre l'arrêt
 * avant de recréer) vit ici plutôt que dans les routes HTTP : le WebSocket, le
 * planificateur et l'API doivent tous passer par les mêmes garde-fous.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- voir la surcharge d'événements ci-dessus
export class ServerInstance extends EventEmitter {
  private state: ServerState = 'offline';
  private readonly console = new ConsoleBuffer();
  private readonly assembler = new LineAssembler();

  private stream: Duplex | null = null;
  private statsStream: NodeJS.ReadableStream | null = null;
  private startedAt: number | null = null;

  /** Dernière mesure du volume, et instant où elle a été prise. */
  private diskBytes = 0;
  private diskMeasuredAt = 0;
  private diskWalk: Promise<unknown> | null = null;

  /**
   * Sérialise les actions de puissance.
   *
   * Deux clics rapides sur « Redémarrer » lanceraient sinon deux séquences
   * concurrentes, et l'une recréerait le conteneur pendant que l'autre l'arrête.
   */
  private operation: Promise<unknown> = Promise.resolve();

  private readonly startupPattern: RegExp | null;

  constructor(private options: ServerInstanceOptions) {
    super();
    this.startupPattern = this.compileStartupPattern();
  }

  get uuid(): string {
    return this.options.configuration.uuid;
  }

  get configuration(): ServerConfiguration {
    return this.options.configuration;
  }

  get currentState(): ServerState {
    return this.state;
  }

  get volumePath(): string {
    return join(this.options.volumesRoot, this.uuid);
  }

  /**
   * Relevé d'un serveur à l'arrêt, pour un client qui vient de se connecter.
   *
   * Un serveur éteint n'émet aucune statistique — la page resterait donc sans
   * chiffres, y compris pour l'espace disque, qui lui reste bel et bien occupé.
   */
  get idleUsage(): ResourceUsage {
    this.refreshDiskUsage();
    return emptyUsage(this.state, this.diskBytes);
  }

  private get logger(): Logger {
    return this.options.logger;
  }

  /**
   * Une regex de template est une donnée, pas du code : elle peut être invalide.
   * Le serveur doit rester utilisable dans ce cas, quitte à passer `running` dès
   * que le conteneur tourne.
   */
  private compileStartupPattern(): RegExp | null {
    const source = this.options.configuration.startupDetection;

    if (!source) {
      return null;
    }

    try {
      return new RegExp(source);
    } catch (error: unknown) {
      this.logger.warn(
        { server: this.uuid, pattern: source, err: error },
        'Expression de détection de démarrage invalide : le serveur passera en ligne dès le lancement du conteneur',
      );
      return null;
    }
  }

  updateConfiguration(configuration: ServerConfiguration): void {
    this.options = { ...this.options, configuration };
  }

  consoleSnapshot(): string[] {
    return this.console.snapshot();
  }

  // -------------------------------------------------------------------------
  // État
  // -------------------------------------------------------------------------

  private setState(state: ServerState): void {
    if (this.state === state) {
      return;
    }

    this.logger.debug({ server: this.uuid, from: this.state, to: state }, "Changement d'état");
    this.state = state;

    if (state === 'running' && this.startedAt === null) {
      this.startedAt = Date.now();
    } else if (state === 'offline') {
      this.startedAt = null;
    }

    this.emit('state', state);
  }

  /** Message émis par Hopper, distinct de la sortie du serveur. */
  private emitDaemonLine(message: string): void {
    const line = `[Hopper] ${message}`;
    this.console.push(line);
    this.emit('console', line);
  }

  private handleOutput(chunk: Buffer | string): void {
    const lines = this.assembler.push(chunk.toString('utf8'));

    for (const line of lines) {
      this.console.push(line);
      this.emit('console', line);

      // La bascule `starting` → `running` se joue ici : c'est le serveur
      // lui-même qui annonce qu'il accepte les connexions.
      if (this.state === 'starting' && this.startupPattern?.test(line)) {
        this.setState('running');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Conteneur
  // -------------------------------------------------------------------------

  private container(): Dockerode.Container {
    return this.options.docker.api.getContainer(containerNameFor(this.uuid));
  }

  async containerExists(): Promise<boolean> {
    try {
      await this.container().inspect();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Crée le conteneur, en supprimant l'ancien si nécessaire.
   * Le volume n'est jamais touché : c'est là que vivent les données du serveur.
   */
  async createContainer(): Promise<void> {
    await mkdir(this.volumePath, { recursive: true });

    if (await this.containerExists()) {
      this.logger.debug({ server: this.uuid }, "Suppression de l'ancien conteneur");
      await this.container()
        .remove({ force: true })
        .catch((error: unknown) => {
          this.logger.warn({ server: this.uuid, err: error }, 'Suppression du conteneur échouée');
        });
    }

    const options = buildContainerOptions({
      configuration: this.options.configuration,
      volumePath: this.volumePath,
      networkName: this.options.networkName,
      ownership: this.options.ownership,
      timezone: this.options.timezone,
      enableBlkioWeight: this.options.enableBlkioWeight,
    });

    await this.options.docker.pullImage(this.options.configuration.container.image, (line) =>
      this.emitDaemonLine(line),
    );

    await this.options.docker.api.createContainer(options);
    this.logger.info({ server: this.uuid }, 'Conteneur créé');
  }

  /**
   * S'attache au flux d'entrée/sortie du conteneur.
   *
   * Fait avant `start()` : s'attacher après ferait perdre les premières lignes,
   * dont les erreurs de démarrage — précisément celles qu'on veut voir.
   */
  private async attach(): Promise<void> {
    if (this.stream) {
      return;
    }

    // Attache maison plutôt que `container.attach()` de dockerode : voir le
    // commentaire de `DockerClient.attachToContainer`, qui explique pourquoi la
    // version de la bibliothèque injecte ses propres options dans stdin.
    const stream = await this.options.docker.attachToContainer(containerNameFor(this.uuid));

    stream.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    stream.on('error', (error: Error) => {
      this.logger.warn({ server: this.uuid, err: error }, 'Flux de console interrompu');
    });
    stream.on('end', () => {
      this.assembler.flush().forEach((line) => {
        this.console.push(line);
        this.emit('console', line);
      });
      this.stream = null;

      // La fin du flux signale l'arrêt du processus, y compris un plantage que
      // personne n'a demandé. On interroge alors Docker pour en donner la
      // cause : un serveur qui disparaît sans explication est le pire cas pour
      // celui qui l'exploite.
      const wasStopping = this.state === 'stopping';
      void this.explainExit(wasStopping);

      this.setState('offline');
      this.stopStatsStream();
    });

    this.stream = stream;
  }

  /**
   * Explique en console pourquoi le processus s'est arrêté.
   *
   * Le cas qui compte est le dépassement mémoire : le noyau tue le processus
   * sans le prévenir, les journaux du serveur s'interrompent au milieu d'une
   * phrase, et rien n'indique ce qui s'est passé. L'opérateur conclut à un
   * plantage de son plugin et cherche des heures au mauvais endroit.
   */
  private async explainExit(wasStopping: boolean): Promise<void> {
    let info: Awaited<ReturnType<Dockerode.Container['inspect']>> | null = null;

    try {
      info = await this.container().inspect();
    } catch {
      // Conteneur déjà supprimé : rien à expliquer.
    }

    if (info?.State.OOMKilled) {
      const limitMib = Math.floor(this.options.configuration.build.memoryBytes / (1024 * 1024));

      this.emitDaemonLine(
        `Le serveur a été arrêté par le noyau pour dépassement mémoire (limite : ${limitMib} Mio).`,
      );
      this.emitDaemonLine(
        'Augmentez la mémoire allouée à ce serveur : la version de Minecraft installée en demande davantage.',
      );

      this.logger.warn(
        { server: this.uuid, limitMib },
        'Serveur tué par le noyau pour dépassement mémoire',
      );
      return;
    }

    if (wasStopping) {
      return;
    }

    const code = info?.State.ExitCode;
    this.emitDaemonLine(
      code === undefined || code === 0
        ? 'Le processus du serveur s’est arrêté.'
        : `Le processus du serveur s’est arrêté (code ${code}).`,
    );
  }

  // -------------------------------------------------------------------------
  // Statistiques
  // -------------------------------------------------------------------------

  private async startStatsStream(): Promise<void> {
    if (this.statsStream) {
      return;
    }

    const stream = await this.container().stats({ stream: true });
    const assembler = new LineAssembler();

    stream.on('data', (chunk: Buffer) => {
      // Docker envoie un objet JSON par ligne ; un objet peut être scindé entre
      // deux paquets, d'où le ré-assemblage.
      for (const line of assembler.push(chunk.toString('utf8'))) {
        if (line.trim() === '') {
          continue;
        }

        try {
          const stats = JSON.parse(line) as DockerStats;
          this.refreshDiskUsage();
          this.emit(
            'stats',
            buildResourceUsage(stats, {
              state: this.state,
              startedAt: this.startedAt,
              diskBytes: this.diskBytes,
            }),
          );
        } catch {
          // Une ligne tronquée par la fermeture du flux n'a pas à faire de bruit.
        }
      }
    });

    stream.on('error', () => this.stopStatsStream());
    stream.on('end', () => {
      this.statsStream = null;
    });

    this.statsStream = stream;
  }

  private stopStatsStream(): void {
    // Le flux de statistiques est un `ReadableStream` sans `destroy` déclaré,
    // alors que l'implémentation Node en fournit un : sans lui, la connexion
    // HTTP vers Docker resterait ouverte après chaque arrêt de serveur.
    const stream: (NodeJS.ReadableStream & { destroy?: () => void }) | null = this.statsStream;
    stream?.destroy?.();
    this.statsStream = null;
    this.emit('stats', emptyUsage(this.state, this.diskBytes));
  }

  /**
   * Met à jour la taille du volume, au plus une fois par intervalle.
   *
   * Docker ne mesure pas l'espace occupé par un montage : il faut parcourir
   * l'arborescence. Sur un serveur moddé, elle compte des dizaines de milliers
   * de fichiers — le faire à chaque relevé de statistiques, soit une fois par
   * seconde, tiendrait le disque occupé en permanence pour un chiffre qui bouge
   * de quelques mégaoctets par minute.
   *
   * La mesure ne bloque pas l'émission : le relevé courant porte la valeur
   * précédente, et le suivant portera la nouvelle.
   */
  private refreshDiskUsage(): void {
    if (this.diskWalk !== null || Date.now() - this.diskMeasuredAt < DISK_MEASURE_INTERVAL_MS) {
      return;
    }

    this.diskWalk = directorySize(this.volumePath)
      .then((bytes) => {
        this.diskBytes = bytes;
      })
      .catch(() => {
        // Volume absent ou illisible : on garde la dernière valeur connue
        // plutôt que d'annoncer un disque vide.
      })
      .finally(() => {
        // L'horodatage est posé à la **fin** : sur un volume énorme, la mesure
        // peut durer plus longtemps que l'intervalle, et le compter depuis le
        // départ enchaînerait les parcours sans répit.
        this.diskMeasuredAt = Date.now();
        this.diskWalk = null;
      });
  }

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /**
   * Installe le serveur, puis crée son conteneur d'exécution.
   *
   * Enfilée comme une action de puissance : une réinstallation demandée pendant
   * un démarrage doit attendre, pas écraser les fichiers sous les pieds d'une
   * JVM en train de les lire.
   */
  async install(startOnCompletion: boolean): Promise<void> {
    return this.enqueue(async () => {
      // Un serveur en cours doit être arrêté avant : réinstaller sous un
      // processus vivant corrompt à coup sûr quelque chose.
      if (this.state === 'running' || this.state === 'starting') {
        await this.doStop();
      }

      this.setState('installing');
      this.console.clear();
      this.emit('install_started');
      this.emitDaemonLine('Installation du serveur…');

      let successful = false;

      try {
        const result = await runInstallation(this.options.docker, {
          configuration: this.options.configuration,
          volumePath: this.volumePath,
          tmpPath: this.options.tmpPath,
          ownership: this.options.ownership,
          networkName: this.options.networkName,
          onOutput: (line) => {
            this.console.push(line);
            this.emit('console', line);
            this.emit('install_output', line);
          },
        });

        successful = result.successful;

        if (!successful) {
          this.emitDaemonLine(`Installation échouée (code ${result.exitCode}).`);
        }
      } catch (error: unknown) {
        this.logger.error({ server: this.uuid, err: error }, 'Installation échouée');
        this.emitDaemonLine(
          `Installation échouée : ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      this.emit('install_completed', successful);
      this.setState(successful ? 'offline' : 'install_failed');

      if (!successful) {
        return;
      }

      this.emitDaemonLine('Installation terminée. Préparation du conteneur…');
      await this.createContainer();

      // Rapporté au panel avant le démarrage : c'est ce qui fait passer le
      // serveur de INSTALLING à READY dans l'interface. Un échec de rapport ne
      // doit pas empêcher le serveur de démarrer.
      await this.options.panel
        .reportInstall(this.uuid, true)
        .catch((error: unknown) =>
          this.logger.error({ server: this.uuid, err: error }, "Rapport d'installation échoué"),
        );

      if (startOnCompletion) {
        await this.doStart();
      }
    }).catch(async (error: unknown) => {
      await this.options.panel.reportInstall(this.uuid, false).catch(() => undefined);
      throw error;
    });
  }

  // -------------------------------------------------------------------------
  // Actions de puissance
  // -------------------------------------------------------------------------

  /** Enfile une action pour qu'elle n'en croise jamais une autre. */
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    // La chaîne ne doit pas se rompre sur un échec, sinon toute action ultérieure
    // serait rejetée avec l'erreur de la précédente.
    this.operation = next.catch(() => undefined);
    return next;
  }

  async power(action: PowerAction): Promise<void> {
    return this.enqueue(async () => {
      switch (action) {
        case 'start':
          return this.doStart();
        case 'stop':
          return this.doStop();
        case 'restart':
          await this.doStop();
          return this.doStart();
        case 'kill':
          return this.doKill();
      }
    });
  }

  private async doStart(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      this.emitDaemonLine('Le serveur est déjà démarré.');
      return;
    }

    if (this.options.configuration.suspended) {
      throw new Error('Ce serveur est suspendu.');
    }

    this.setState('starting');
    this.console.clear();
    this.emitDaemonLine('Démarrage du serveur…');

    if (this.options.configuration.container.requiresRebuild || !(await this.containerExists())) {
      this.emitDaemonLine('Construction du conteneur…');
      await this.createContainer();
    }

    await this.attach();
    await this.container().start();
    await this.startStatsStream();

    if (!this.startupPattern) {
      // Sans marqueur de démarrage, le conteneur qui tourne est le seul signal
      // disponible.
      this.setState('running');
    }
  }

  /**
   * Arrêt propre.
   *
   * Envoie la commande d'arrêt du template sur stdin (`stop` pour un serveur
   * Bukkit) et laisse le serveur sauvegarder ses mondes. Un SIGKILL immédiat
   * corromprait des régions de map.
   */
  private async doStop(): Promise<void> {
    if (this.state === 'offline') {
      return;
    }

    this.setState('stopping');

    const { stop, stopTimeoutSeconds } = this.options.configuration;

    if (stop.type === 'command') {
      this.emitDaemonLine(`Arrêt en cours (commande « ${stop.value} »)…`);
      await this.sendCommand(stop.value);
    } else {
      this.emitDaemonLine(`Arrêt en cours (signal ${stop.value})…`);
      await this.container().kill({ signal: stop.value });
    }

    const stopped = await this.waitForState('offline', stopTimeoutSeconds * 1000);

    if (!stopped) {
      this.emitDaemonLine(
        `Le serveur n’a pas répondu en ${stopTimeoutSeconds} s : arrêt forcé. Une perte de données est possible.`,
      );
      await this.doKill();
    }
  }

  private async doKill(): Promise<void> {
    this.emitDaemonLine('Arrêt forcé du conteneur.');

    await this.container()
      .kill({ signal: 'SIGKILL' })
      .catch((error: unknown) => {
        this.logger.debug({ server: this.uuid, err: error }, 'Conteneur déjà arrêté');
      });

    this.setState('offline');
    this.stopStatsStream();
  }

  /** Attend un état, ou expire. Retourne `false` en cas d'expiration. */
  private waitForState(target: ServerState, timeoutMs: number): Promise<boolean> {
    if (this.state === target) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('state', listener);
        resolve(false);
      }, timeoutMs);

      const listener = (state: ServerState): void => {
        if (state === target) {
          clearTimeout(timer);
          this.off('state', listener);
          resolve(true);
        }
      };

      this.on('state', listener);
    });
  }

  /**
   * Écrit une commande sur l'entrée standard du serveur.
   *
   * Le retour à la ligne est ajouté ici et la commande est débarrassée des
   * siens : une valeur contenant `\n` enverrait sinon plusieurs commandes d'un
   * coup, ce qui contournerait la journalisation d'audit ligne par ligne.
   */
  async sendCommand(command: string): Promise<void> {
    if (!this.stream) {
      throw new Error("Le serveur n'est pas démarré.");
    }

    const sanitized = command.replace(/[\r\n]+/g, ' ').trim();

    if (sanitized === '') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.stream!.write(`${sanitized}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  // -------------------------------------------------------------------------

  /** Détache les flux sans toucher au conteneur. */
  detach(): void {
    this.stream?.destroy();
    this.stream = null;
    this.stopStatsStream();
  }

  /** Supprime le conteneur. Le volume est traité par l'appelant. */
  async destroyContainer(): Promise<void> {
    this.detach();

    if (await this.containerExists()) {
      await this.container().remove({ force: true, v: false });
    }

    this.setState('offline');
  }

  /**
   * Aligne l'état interne sur la réalité du conteneur.
   * Appelé au démarrage du daemon : les serveurs continuent de tourner pendant
   * un redémarrage de hopperd, et il faut les retrouver.
   */
  async reconcile(): Promise<void> {
    try {
      const info = await this.container().inspect();

      if (info.State.Running) {
        this.logger.info({ server: this.uuid }, 'Serveur déjà en cours : ré-attachement');
        await this.attach();
        await this.startStatsStream();
        this.startedAt = new Date(info.State.StartedAt).getTime();
        // Le marqueur de démarrage est passé avant notre attache : on ne peut
        // que constater que le conteneur tourne.
        this.setState('running');
      } else {
        this.setState('offline');
      }
    } catch {
      this.setState(this.options.configuration.suspended ? 'suspended' : 'offline');
    }
  }
}
