import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SubusersController } from './subusers.controller.js';
import { SubusersService } from './subusers.service.js';

@Module({
  imports: [AuditModule],
  controllers: [SubusersController],
  providers: [SubusersService],
})
export class SubusersModule {}
