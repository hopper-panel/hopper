-- Outgoing notifications about the instance, not about one server.
--
-- A table of its own rather than a nullable `serverId` on `webhooks`, because
-- the two answer different people about different things. That one belongs to a
-- server's owner and tells them their world restarted; this one belongs to the
-- operator and tells their billing system that a purchase finished installing.
-- Sharing a table would mean every query on either having to remember which
-- kind it was looking at — and one forgotten `WHERE` handing a customer the
-- instance's events, or an operator's recipient every restart of every server
-- on the machine.
--
-- What it carries is the set of things an integration cannot observe for
-- itself: a purchase finishing, or failing, minutes after the call that ordered
-- it already returned. Everything else it can ask about.
CREATE TABLE "instance_webhooks" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    -- Empty means nothing is sent. Same as the per-server ones: subscribing to
    -- nothing has to be expressible, and has to be the state a half-configured
    -- recipient is in.
    "events" TEXT[],
    -- Encrypted at rest with APP_SECRET, like every other secret the panel has
    -- to present rather than merely check.
    "secretEncrypted" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    -- Past the threshold it disables itself, so a dead address stops costing
    -- five seconds of timeout on every provisioning call.
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_webhooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "instance_webhooks_uuid_key" ON "instance_webhooks"("uuid");
