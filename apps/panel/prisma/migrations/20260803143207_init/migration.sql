-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('INSTALLING', 'INSTALL_FAILED', 'READY', 'SUSPENDED', 'DELETING', 'REINSTALLING');

-- CreateEnum
CREATE TYPE "BackupDriver" AS ENUM ('LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "TaskAction" AS ENUM ('COMMAND', 'POWER', 'BACKUP');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_codes" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "identifier" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "scopes" TEXT[],
    "allowedIps" TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "fqdn" TEXT NOT NULL,
    "scheme" TEXT NOT NULL DEFAULT 'https',
    "port" INTEGER NOT NULL DEFAULT 8443,
    "daemonTokenId" TEXT NOT NULL,
    "daemonTokenHash" TEXT NOT NULL,
    "jwtSecret" TEXT NOT NULL,
    "memoryBytes" BIGINT NOT NULL DEFAULT 0,
    "diskBytes" BIGINT NOT NULL DEFAULT 0,
    "memoryOverallocation" INTEGER NOT NULL DEFAULT 0,
    "diskOverallocation" INTEGER NOT NULL DEFAULT 0,
    "maintenance" BOOLEAN NOT NULL DEFAULT false,
    "sftpPort" INTEGER NOT NULL DEFAULT 2022,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" SERIAL NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "ip" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "alias" TEXT,
    "serverId" INTEGER,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_groups" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "groupId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL DEFAULT '',
    "dockerImages" JSONB NOT NULL,
    "startup" TEXT NOT NULL,
    "stopCommand" TEXT NOT NULL DEFAULT 'command:stop',
    "startupDetection" TEXT,
    "configFiles" JSONB NOT NULL DEFAULT '[]',
    "fileDenylist" TEXT[],
    "installContainer" TEXT NOT NULL DEFAULT 'debian:bookworm-slim',
    "installEntrypoint" TEXT NOT NULL DEFAULT '/bin/bash',
    "installScript" TEXT NOT NULL DEFAULT '',
    "importedFromEgg" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_variables" (
    "id" SERIAL NOT NULL,
    "templateId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "envVariable" TEXT NOT NULL,
    "defaultValue" TEXT NOT NULL DEFAULT '',
    "userViewable" BOOLEAN NOT NULL DEFAULT true,
    "userEditable" BOOLEAN NOT NULL DEFAULT false,
    "rules" TEXT NOT NULL DEFAULT 'nullable|string',

    CONSTRAINT "template_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "ownerId" INTEGER NOT NULL,
    "nodeId" INTEGER NOT NULL,
    "templateId" INTEGER NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'INSTALLING',
    "primaryAllocationId" INTEGER,
    "memoryBytes" BIGINT NOT NULL,
    "swapBytes" BIGINT NOT NULL DEFAULT 0,
    "diskBytes" BIGINT NOT NULL,
    "cpuPercent" INTEGER NOT NULL DEFAULT 0,
    "cpuSet" TEXT NOT NULL DEFAULT '',
    "ioWeight" INTEGER NOT NULL DEFAULT 500,
    "pidsLimit" INTEGER NOT NULL DEFAULT 512,
    "oomKillDisabled" BOOLEAN NOT NULL DEFAULT false,
    "dockerImage" TEXT NOT NULL,
    "startupCommand" TEXT NOT NULL,
    "requiresRebuild" BOOLEAN NOT NULL DEFAULT false,
    "backupLimit" INTEGER NOT NULL DEFAULT 3,
    "databaseLimit" INTEGER NOT NULL DEFAULT 0,
    "allocationLimit" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_variables" (
    "id" SERIAL NOT NULL,
    "serverId" INTEGER NOT NULL,
    "envVariable" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "server_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subusers" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "serverId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subusers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "serverId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "driver" "BackupDriver" NOT NULL DEFAULT 'LOCAL',
    "ignoredFiles" TEXT[],
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "successful" BOOLEAN,
    "errorDetail" TEXT,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "serverId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "cronMinute" TEXT NOT NULL DEFAULT '*',
    "cronHour" TEXT NOT NULL DEFAULT '*',
    "cronDayOfMonth" TEXT NOT NULL DEFAULT '*',
    "cronMonth" TEXT NOT NULL DEFAULT '*',
    "cronDayOfWeek" TEXT NOT NULL DEFAULT '*',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "onlyWhenOnline" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "running" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_tasks" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" "TaskAction" NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '',
    "offsetSeconds" INTEGER NOT NULL DEFAULT 0,
    "continueOnFailure" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "schedule_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "actorId" INTEGER,
    "serverId" INTEGER,
    "event" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_uuid_key" ON "users"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_suspended_idx" ON "users"("suspended");

-- CreateIndex
CREATE INDEX "recovery_codes_userId_idx" ON "recovery_codes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_family_idx" ON "sessions"("family");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_identifier_key" ON "api_keys"("identifier");

-- CreateIndex
CREATE INDEX "api_keys_userId_idx" ON "api_keys"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_uuid_key" ON "nodes"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "nodes_daemonTokenId_key" ON "nodes"("daemonTokenId");

-- CreateIndex
CREATE INDEX "allocations_serverId_idx" ON "allocations"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "allocations_nodeId_ip_port_key" ON "allocations"("nodeId", "ip", "port");

-- CreateIndex
CREATE UNIQUE INDEX "template_groups_uuid_key" ON "template_groups"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "template_groups_name_key" ON "template_groups"("name");

-- CreateIndex
CREATE UNIQUE INDEX "templates_uuid_key" ON "templates"("uuid");

-- CreateIndex
CREATE INDEX "templates_groupId_idx" ON "templates"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "template_variables_templateId_envVariable_key" ON "template_variables"("templateId", "envVariable");

-- CreateIndex
CREATE UNIQUE INDEX "servers_uuid_key" ON "servers"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "servers_primaryAllocationId_key" ON "servers"("primaryAllocationId");

-- CreateIndex
CREATE INDEX "servers_ownerId_idx" ON "servers"("ownerId");

-- CreateIndex
CREATE INDEX "servers_nodeId_idx" ON "servers"("nodeId");

-- CreateIndex
CREATE INDEX "servers_templateId_idx" ON "servers"("templateId");

-- CreateIndex
CREATE INDEX "servers_status_idx" ON "servers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "server_variables_serverId_envVariable_key" ON "server_variables"("serverId", "envVariable");

-- CreateIndex
CREATE UNIQUE INDEX "subusers_uuid_key" ON "subusers"("uuid");

-- CreateIndex
CREATE INDEX "subusers_userId_idx" ON "subusers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "subusers_serverId_userId_key" ON "subusers"("serverId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "backups_uuid_key" ON "backups"("uuid");

-- CreateIndex
CREATE INDEX "backups_serverId_idx" ON "backups"("serverId");

-- CreateIndex
CREATE INDEX "backups_createdAt_idx" ON "backups"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_uuid_key" ON "schedules"("uuid");

-- CreateIndex
CREATE INDEX "schedules_serverId_idx" ON "schedules"("serverId");

-- CreateIndex
CREATE INDEX "schedules_active_nextRunAt_idx" ON "schedules"("active", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_tasks_uuid_key" ON "schedule_tasks"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_tasks_scheduleId_sequence_key" ON "schedule_tasks"("scheduleId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_uuid_key" ON "audit_logs"("uuid");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- CreateIndex
CREATE INDEX "audit_logs_serverId_idx" ON "audit_logs"("serverId");

-- CreateIndex
CREATE INDEX "audit_logs_event_idx" ON "audit_logs"("event");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "template_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_variables" ADD CONSTRAINT "template_variables_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_primaryAllocationId_fkey" FOREIGN KEY ("primaryAllocationId") REFERENCES "allocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_variables" ADD CONSTRAINT "server_variables_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_tasks" ADD CONSTRAINT "schedule_tasks_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
