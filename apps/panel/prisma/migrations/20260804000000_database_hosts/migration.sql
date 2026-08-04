-- CreateTable
CREATE TABLE "database_hosts" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 3306,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "publicHost" TEXT,
    "publicPort" INTEGER,
    "nodeId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "databases" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "serverId" INTEGER NOT NULL,
    "hostId" INTEGER NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "remote" TEXT NOT NULL DEFAULT '%',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "database_hosts_uuid_key" ON "database_hosts"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "databases_uuid_key" ON "databases"("uuid");

-- CreateIndex
CREATE INDEX "databases_serverId_idx" ON "databases"("serverId");

-- CreateIndex
CREATE UNIQUE INDEX "databases_hostId_database_key" ON "databases"("hostId", "database");

-- AddForeignKey
ALTER TABLE "database_hosts" ADD CONSTRAINT "database_hosts_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "database_hosts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
