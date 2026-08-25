import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';
import { Public } from '../auth/decorators.js';
import { InstanceSettingsService } from './instance-settings.service.js';

/**
 * Public identity of the instance.
 *
 * The sign-in page needs the panel name and the default language *before*
 * anyone is authenticated. Nothing here tells an anonymous visitor anything
 * they could not read from the page title or from the address bar.
 *
 * `url` is that last one, and it is here because a panel reached by an address
 * other than its own works — every page, every button — right up to the moment
 * a console is opened, which the node refuses because a browser's `Origin` is
 * not on its list. The same mismatch quietly breaks passkeys, whose relying
 * party is derived from this URL, and it puts a different address in every link
 * the panel emails out. The browser is the only place that can notice: it is
 * the one that knows which address was typed. So it is told which one was
 * expected.
 */
@Controller('api/panel')
export class BrandingController {
  private readonly appUrl: string;

  constructor(
    private readonly settings: InstanceSettingsService,
    config: ConfigService<Environment, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  @Get()
  @Public()
  async get(): Promise<{ name: string; defaultLocale: string; url: string }> {
    const settings = await this.settings.all();

    return {
      name: settings.panelName,
      defaultLocale: settings.defaultLocale,
      url: this.appUrl,
    };
  }
}
