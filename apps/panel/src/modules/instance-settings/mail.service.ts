import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Environment } from '../../config/environment.js';
import { InstanceSettingsService } from './instance-settings.service.js';
import type { InstanceSettings } from './definitions.js';

/**
 * Sending emails.
 *
 * The transport is built on demand from the settings in the database, not at
 * startup: changing the SMTP server in the administration has to take effect
 * without restarting the panel. It is cached as long as the configuration does
 * not move, so as not to reopen a TLS connection for every message.
 *
 * No send makes the action that triggered it fail: creating an account has to
 * succeed even if the SMTP server is misconfigured. The failure is logged, and
 * the administration offers a test send to diagnose it.
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
   * Verification send, triggered from the administration.
   *
   * This one **throws** on failure, unlike ordinary sends: that is the whole
   * point of the button, and a precise error message beats a "sent" that
   * teaches nothing.
   */
  async sendTest(to: string): Promise<void> {
    const settings = await this.settings.all();

    if (!settings.mailEnabled) {
      throw new BadRequestException('Enable mail sending before running a test.');
    }

    if (settings.mailHost === '' || settings.mailFromAddress === '') {
      throw new BadRequestException('Fill in at least the SMTP server and the sending address.');
    }

    try {
      await this.transport(settings).sendMail({
        from: this.from(settings),
        to,
        subject: `${settings.panelName} — verification email`,
        text: [
          'This message confirms your SMTP server is correctly configured.',
          '',
          `Sent by ${settings.panelName} from ${this.panelUrl()}.`,
        ].join('\n'),
      });
    } catch (error: unknown) {
      throw new BadRequestException(
        `Could not send: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Welcomes an account created by an administrator.
   *
   * The message contains **no** password: a password sent by email stays
   * readable in the recipient's mailbox, on their provider's server and in that
   * provider's backups. It carries a single-use link to choose one instead.
   */
  async sendWelcome(input: {
    to: string;
    username: string;
    setupUrl: string;
    expiresInHours: number;
  }): Promise<void> {
    const settings = await this.settings.all();

    if (!(await this.isConfigured())) {
      this.logger.log(`Welcome email not sent to ${input.to}: no SMTP server configured.`);
      return;
    }

    const url = this.panelUrl();

    try {
      await this.transport(settings).sendMail({
        from: this.from(settings),
        to: input.to,
        subject: `${settings.panelName} — your account has been created`,
        text: [
          `Hello ${input.username},`,
          '',
          `An account has just been created for you on ${settings.panelName} (${url}).`,
          '',
          'Choose your password by following this link:',
          input.setupUrl,
          '',
          `This link is valid for ${input.expiresInHours} hours and works only once.`,
          'After that, ask an administrator to send you a new one.',
          '',
          'If you were not expecting this message, ignore it: without a password the account stays unusable.',
        ].join('\n'),
      });
    } catch (error: unknown) {
      // Logged, never propagated: creating the account succeeded, and failing
      // it after the fact would leave an account without its email.
      this.logger.error(
        `Welcome email not delivered to ${input.to}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private panelUrl(): string {
    // No trailing slash to strip: `APP_URL` is reduced to its origin when the
    // environment is read.
    return this.config.get('APP_URL', { infer: true });
  }

  private from(settings: InstanceSettings): string {
    return `"${settings.mailFromName}" <${settings.mailFromAddress}>`;
  }

  /**
   * Current transport, rebuilt as soon as a setting changes.
   *
   * The signature acts as the witness: comparing the values one by one would
   * amount to the same, but each new field would have to be remembered — and
   * forgetting one would show up as an edited configuration with no effect.
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
      // `secure` is true for implicit TLS (port 465). With STARTTLS the
      // connection opens in the clear then switches: `secure` has to stay
      // false, or the handshake fails with no comprehensible message.
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
