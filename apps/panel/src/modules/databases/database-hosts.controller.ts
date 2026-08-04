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
 * MySQL servers the panel can create databases on.
 *
 * Administrators only, and that is not a formality: declaring a host means
 * handing the panel an account with **every right** on that SQL server. The
 * password is never returned by these routes — it is stored encrypted because
 * the panel has to present it on every connection, but nothing justifies
 * displaying it again.
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
    // The connection is tested **before** saving: a host that does not answer
    // would otherwise stay in the list, and the error would only appear at the
    // first database creation, far from its cause.
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
      throw new BadRequestException('Node not found.');
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

    // Removing a host that databases depend on would make them unreachable
    // without deleting them: they would go on existing on the SQL server, with
    // the panel no longer able to name them.
    if (databases > 0) {
      throw new ConflictException(
        `${databases} database(s) live on this server. Delete them from their servers before ` +
          'removing the host.',
      );
    }

    await this.prisma.databaseHost.delete({ where: { id: host.id } });
  }

  private async requireHost(uuid: string) {
    const host = await this.prisma.databaseHost.findUnique({ where: { uuid } });

    if (!host) {
      throw new NotFoundException('Database server not found.');
    }

    return host;
  }
}
