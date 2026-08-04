import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Environment } from '../../config/environment.js';
import { InstanceSettingsService } from './instance-settings.service.js';
import type { InstanceSettings } from './definitions.js';

/**
 * Envoi de courriels.
 *
 * Le transport est construit à la demande à partir des paramètres en base, et
 * non au démarrage : changer le serveur SMTP dans l'administration doit prendre
 * effet sans redémarrer le panel. Il est mis en cache tant que la configuration
 * ne bouge pas, pour ne pas rouvrir une connexion TLS à chaque message.
 *
 * Aucun envoi ne fait échouer l'action qui l'a déclenché : créer un compte doit
 * réussir même si le serveur SMTP est mal réglé. L'échec est journalisé, et
 * l'administration propose un envoi de test pour le diagnostiquer.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  private transporter: Transporter | null = null;
  private signature = '';

  constructor(
    private readonly settings: InstanceSettingsService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async isConfigured(): Promise<boolean> {
    const settings = await this.settings.all();

    return settings.mailEnabled && settings.mailHost !== '' && settings.mailFromAddress !== '';
  }

  /**
   * Envoi de vérification, déclenché depuis l'administration.
   *
   * Celui-ci **lève** en cas d'échec, contrairement aux envois ordinaires :
   * c'est tout l'objet du bouton, et un message d'erreur précis vaut mieux
   * qu'un « envoyé » qui n'apprend rien.
   */
  async sendTest(to: string): Promise<void> {
    const settings = await this.settings.all();

    if (!settings.mailEnabled) {
      throw new BadRequestException('Activez l’envoi de courriels avant de faire un test.');
    }

    if (settings.mailHost === '' || settings.mailFromAddress === '') {
      throw new BadRequestException(
        'Renseignez au moins le serveur SMTP et l’adresse d’expédition.',
      );
    }

    try {
      await this.transport(settings).sendMail({
        from: this.from(settings),
        to,
        subject: `${settings.panelName} — courriel de vérification`,
        text: [
          'Ce message confirme que votre serveur SMTP est correctement configuré.',
          '',
          `Envoyé par ${settings.panelName} depuis ${this.panelUrl()}.`,
        ].join('\n'),
      });
    } catch (error: unknown) {
      throw new BadRequestException(
        `Envoi impossible : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Souhaite la bienvenue à un compte créé par un administrateur.
   *
   * Le message ne contient **pas** de mot de passe : un mot de passe envoyé par
   * courriel reste lisible dans la boîte du destinataire, sur le serveur de son
   * fournisseur et dans les sauvegardes de celui-ci. Il porte un lien à usage
   * unique qui permet d'en choisir un.
   */
  async sendWelcome(input: {
    to: string;
    username: string;
    setupUrl: string;
    expiresInHours: number;
  }): Promise<void> {
    const settings = await this.settings.all();

    if (!(await this.isConfigured())) {
      this.logger.log(
        `Courriel de bienvenue non envoyé à ${input.to} : aucun serveur SMTP configuré.`,
      );
      return;
    }

    const url = this.panelUrl();

    try {
      await this.transport(settings).sendMail({
        from: this.from(settings),
        to: input.to,
        subject: `${settings.panelName} — votre compte a été créé`,
        text: [
          `Bonjour ${input.username},`,
          '',
          `Un compte vient d'être créé pour vous sur ${settings.panelName} (${url}).`,
          '',
          'Choisissez votre mot de passe en suivant ce lien :',
          input.setupUrl,
          '',
          `Ce lien est valable ${input.expiresInHours} heures et ne fonctionne qu'une fois.`,
          'Passé ce délai, demandez à un administrateur de vous en envoyer un nouveau.',
          '',
          "Si vous n'attendiez pas ce message, ignorez-le : sans mot de passe, le compte reste inutilisable.",
        ].join('\n'),
      });
    } catch (error: unknown) {
      // Journalisé, jamais propagé : la création du compte a réussi, et la
      // faire échouer après coup laisserait un compte sans son courriel.
      this.logger.error(
        `Courriel de bienvenue non remis à ${input.to} : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private panelUrl(): string {
    return this.config.get('APP_URL', { infer: true }).replace(/\/$/, '');
  }

  private from(settings: InstanceSettings): string {
    return `"${settings.mailFromName}" <${settings.mailFromAddress}>`;
  }

  /**
   * Transport courant, reconstruit dès qu'un paramètre change.
   *
   * La signature sert de témoin : comparer les valeurs une à une reviendrait au
   * même, mais il faudrait penser à ajouter chaque nouveau champ — et l'oubli
   * se manifesterait par une configuration modifiée qui n'a pas d'effet.
   */
  private transport(settings: InstanceSettings): Transporter {
    const signature = JSON.stringify([
      settings.mailHost,
      settings.mailPort,
      settings.mailEncryption,
      settings.mailUsername,
      settings.mailPassword,
    ]);

    if (this.transporter && this.signature === signature) {
      return this.transporter;
    }

    this.transporter?.close();

    this.transporter = createTransport({
      host: settings.mailHost,
      port: settings.mailPort,
      // `secure` vaut vrai pour du TLS implicite (port 465). En STARTTLS, la
      // connexion s'ouvre en clair puis bascule : `secure` doit rester faux,
      // sinon la poignée de main échoue sans message compréhensible.
      secure: settings.mailEncryption === 'tls',
      requireTLS: settings.mailEncryption === 'starttls',
      auth:
        settings.mailUsername === ''
          ? undefined
          : { user: settings.mailUsername, pass: settings.mailPassword },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    this.signature = signature;

    return this.transporter;
  }
}
