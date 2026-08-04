import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CryptoService } from '../../common/crypto/crypto.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AdminOnly } from '../auth/decorators.js';
import { createDatabaseHostSchema, type CreateDatabaseHostDto } from './databases.dto.js';
import { MysqlClientService } from './mysql-client.service.js';

/**
 * Serveurs MySQL sur lesquels le panel peut créer des bases.
 *
 * Réservé aux administrateurs, et ce n'est pas une précaution de forme :
 * déclarer un host revient à confier au panel un compte qui a **tous les
 * droits** sur ce serveur SQL. Le mot de passe n'est jamais renvoyé par ces
 * routes — il est stocké chiffré parce que le panel doit le présenter à chaque
 * connexion, mais rien ne justifie de le réafficher.
 */
@Controller('api/admin/database-hosts')
@AdminOnly()
export class DatabaseHostsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mysql: MysqlClientService,
  ) {}

  @Get()
  async list() {
    const hosts = await this.prisma.databaseHost.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        node: { select: { uuid: true, name: true } },
        _count: { select: { databases: true } },
      },
    });

    return {
      data: hosts.map((host) => ({
        uuid: host.uuid,
        name: host.name,
        host: host.host,
        port: host.port,
        username: host.username,
        publicHost: host.publicHost,
        publicPort: host.publicPort,
        node: host.node,
        databases: host._count.databases,
      })),
    };
  }

  @Post()
  async create(@Body(new ZodValidationPipe(createDatabaseHostSchema)) body: CreateDatabaseHostDto) {
    // La connexion est éprouvée **avant** l'enregistrement : un host qui ne
    // répond pas resterait sinon dans la liste, et l'erreur n'apparaîtrait qu'à
    // la première création de base, loin de sa cause.
    await this.mysql.testConnection({
      host: body.host,
      port: body.port,
      username: body.username,
      password: body.password,
    });

    const node = body.nodeUuid
      ? await this.prisma.node.findUnique({
          where: { uuid: body.nodeUuid },
          select: { id: true },
        })
      : null;

    if (body.nodeUuid && !node) {
      throw new BadRequestException('Node introuvable.');
    }

    const created = await this.prisma.databaseHost.create({
      data: {
        name: body.name,
        host: body.host,
        port: body.port,
        username: body.username,
        passwordEncrypted: this.crypto.encrypt(body.password),
        publicHost: body.publicHost?.trim() || null,
        publicPort: body.publicPort ?? null,
        nodeId: node?.id ?? null,
      },
    });

    return { uuid: created.uuid, name: created.name };
  }

  @Post(':hostId/test')
  async test(@Param('hostId') hostId: string) {
    const host = await this.requireHost(hostId);

    return this.mysql.testConnection({
      host: host.host,
      port: host.port,
      username: host.username,
      password: this.crypto.decrypt(host.passwordEncrypted),
    });
  }

  @Delete(':hostId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('hostId') hostId: string): Promise<void> {
    const host = await this.requireHost(hostId);

    const databases = await this.prisma.database.count({ where: { hostId: host.id } });

    // Retirer un host dont dépendent des bases les rendrait inaccessibles sans
    // les supprimer : elles continueraient d'exister sur le serveur SQL, sans
    // que le panel sache encore les nommer.
    if (databases > 0) {
      throw new ConflictException(
        `${databases} base(s) vivent sur ce serveur. Supprimez-les depuis leurs serveurs avant de ` +
          'retirer le host.',
      );
    }

    await this.prisma.databaseHost.delete({ where: { id: host.id } });
  }

  private async requireHost(uuid: string) {
    const host = await this.prisma.databaseHost.findUnique({ where: { uuid } });

    if (!host) {
      throw new NotFoundException('Serveur de bases de données introuvable.');
    }

    return host;
  }
}
