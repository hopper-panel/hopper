import { CONTRACT_VERSION } from '@hopper/shared';
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';
import { AdminOnly, Public } from '../auth/decorators.js';
import { NodeClientService, type NodeConnection } from '../nodes/node-client.service.js';
import { PANEL_VERSION } from '../../version.js';

@Controller('api/health')
export class HealthController {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly nodeClient: NodeClientService,
  ) {}

  /**
   * Liveness probe. Deliberately mute about the configuration: it is called by
   * systemd and by load balancers, sometimes from outside.
   *
   * Public out of necessity: a probe that demands a session cannot do its job.
   * A `systemctl start` would wait forever on a service it believes broken when
   * it answers perfectly.
   */
  @Public()
  @Get()
  health(): { status: 'ok'; version: string; contract: string } {
    return { status: 'ok', version: PANEL_VERSION, contract: CONTRACT_VERSION };
  }

  /**
   * Checks that the panel can reach the development daemon.
   *
   * Administrators only, unlike the probe above: it reveals the existence and
   * the state of a node.
   */
  @AdminOnly()
  @Get('node')
  async nodeHealth(): Promise<Record<string, unknown>> {
    const url = this.config.get('DEV_NODE_URL', { infer: true });
    const token = this.config.get('DEV_NODE_TOKEN', { infer: true });

    if (!url || !token) {
      throw new ServiceUnavailableException(
        'DEV_NODE_URL and DEV_NODE_TOKEN are not set in .env.',
      );
    }

    const connection: NodeConnection = { uuid: 'dev', url, token };
    const health = await this.nodeClient.fetchSystemInformation(connection);

    return { node: connection.uuid, ...health };
  }
}
