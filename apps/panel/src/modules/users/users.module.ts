import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PasswordService } from '../auth/password.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, PasswordService],
  exports: [UsersService],
})
export class UsersModule {}
