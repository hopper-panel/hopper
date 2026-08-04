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
   * Sonde de vitalité. Volontairement muette sur la configuration : elle est
   * appelée par systemd et les load balancers, parfois depuis l'extérieur.
   *
   * Publique par nécessité : une sonde qui exige une session ne peut pas
   * remplir son rôle. Un `systemctl start` attendrait indéfiniment un service
   * qu'il croit en panne alors qu'il répond parfaitement.
   */
  @Public()
  @Get()
  health(): { status: 'ok'; version: string; contract: string } {
    return { status: 'ok', version: PANEL_VERSION, contract: CONTRACT_VERSION };
  }

  /**
   * Vérifie que le panel sait joindre le daemon de développement.
   *
   * Réservée aux administrateurs, contrairement à la sonde ci-dessus : elle
   * révèle l'existence et l'état d'un node.
   */
  @AdminOnly()
  @Get('node')
  async nodeHealth(): Promise<Record<string, unknown>> {
    const url = this.config.get('DEV_NODE_URL', { infer: true });
    const token = this.config.get('DEV_NODE_TOKEN', { infer: true });

    if (!url || !token) {
      throw new ServiceUnavailableException(
        'DEV_NODE_URL et DEV_NODE_TOKEN ne sont pas définis dans .env.',
      );
    }

    const connection: NodeConnection = { uuid: 'dev', url, token };
    const health = await this.nodeClient.fetchSystemInformation(connection);

    return { node: connection.uuid, ...health };
  }
}
