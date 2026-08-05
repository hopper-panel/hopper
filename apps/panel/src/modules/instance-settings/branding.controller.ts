import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { InstanceSettingsService } from './instance-settings.service.js';

/**
 * Public identity of the instance.
 *
 * The sign-in page needs the panel name and the default language *before*
 * anyone is authenticated. Only those two values are exposed — nothing here
 * tells an anonymous visitor anything they could not read from the page title.
 */
@Controller('api/panel')
export class BrandingController {
  constructor(private readonly settings: InstanceSettingsService) {}

  @Get()
  @Public()
  async get(): Promise<{ name: string; defaultLocale: string }> {
    const settings = await this.settings.all();

    return { name: settings.panelName, defaultLocale: settings.defaultLocale };
  }
}
