-- A sellable offer, and the server that remembers being sold under one.
--
-- This exists because of who calls the application API. Without it, a billing
-- system has to know the panel's internals to sell anything: which template
-- uuid, how many bytes of memory, which node has a free port, and a dozen more
-- fields. Every one of those then lives in a second place — in a second
-- product's configuration — and drifts from this one. A plan moves that
-- knowledge into the panel, where the person who decides what is sold can
-- change it, and leaves the billing system a name to quote.
--
-- It is a template for creating a server, not a live dependency. The limits are
-- copied onto the server at creation, exactly as the startup command is copied
-- from its template, so editing an offer does not silently change what two
-- hundred existing customers are running.
CREATE TABLE "plans" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    -- What the billing system quotes. A human types this into a product's
    -- configuration and reads it back in a support ticket, which is why it is
    -- the reference rather than the uuid — and why renaming one is a breaking
    -- change for whatever sells it.
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "templateId" INTEGER NOT NULL,
    -- Empty means the template's default image. A provider selling "Java 8"
    -- and "Java 21" out of one template needs this; one selling a single image
    -- never sets it.
    "dockerImage" TEXT NOT NULL DEFAULT '',
    "memoryBytes" BIGINT NOT NULL,
    "swapBytes" BIGINT NOT NULL DEFAULT 0,
    "diskBytes" BIGINT NOT NULL,
    "cpuPercent" INTEGER NOT NULL DEFAULT 0,
    "ioWeight" INTEGER NOT NULL DEFAULT 500,
    "pidsLimit" INTEGER NOT NULL DEFAULT 512,
    "oomKillDisabled" BOOLEAN NOT NULL DEFAULT false,
    "backupLimit" INTEGER NOT NULL DEFAULT 3,
    "databaseLimit" INTEGER NOT NULL DEFAULT 0,
    "allocationLimit" INTEGER NOT NULL DEFAULT 0,
    -- A retired offer stops being sellable; the customers on it keep running.
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plans_uuid_key" ON "plans"("uuid");
CREATE UNIQUE INDEX "plans_slug_key" ON "plans"("slug");
CREATE INDEX "plans_active_idx" ON "plans"("active");

-- Where an offer may be placed. Empty on both sides means "anywhere", which is
-- what an instance with one node wants and never has to say.
--
-- Many-to-many rather than one node per plan: an offer usually exists on every
-- machine of a region, and duplicating it per node would hand the choice of
-- machine back to the billing system — the decision the plan exists to take
-- away from it.
CREATE TABLE "_PlanNodes" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_PlanNodes_AB_pkey" PRIMARY KEY ("A","B")
);

CREATE INDEX "_PlanNodes_B_index" ON "_PlanNodes"("B");

ALTER TABLE "_PlanNodes" ADD CONSTRAINT "_PlanNodes_A_fkey"
    FOREIGN KEY ("A") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_PlanNodes" ADD CONSTRAINT "_PlanNodes_B_fkey"
    FOREIGN KEY ("B") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plans" ADD CONSTRAINT "plans_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What a server was sold under.
--
-- Nullable, and null it stays for every server an administrator created by
-- hand and for every server that existed before this migration: inventing a
-- "custom" plan to point them at would put a row in the offer list that nobody
-- decided to sell.
--
-- `SET NULL` on delete. Retiring an offer must not refuse because customers are
-- still on it, and must not take their servers with it either. What they run
-- was copied onto the server when it was created; this column records what was
-- sold, and losing that record is the correct cost of deleting the offer.
ALTER TABLE "servers" ADD COLUMN "planId" INTEGER;

CREATE INDEX "servers_planId_idx" ON "servers"("planId");

ALTER TABLE "servers" ADD CONSTRAINT "servers_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
