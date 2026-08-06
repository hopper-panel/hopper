-- What a port is for, as the server's configuration reaches it.
--
-- Nullable and with no default, so the column costs every existing row
-- nothing: they keep a NULL and go on being reached exactly as they were —
-- readiness with no role means the primary port, and that is what every
-- configuration written before this column asks for.
--
-- The unique index is the whole of "a name means one port per server". It
-- needs no partial clause because PostgreSQL treats NULLs in a unique index as
-- distinct: (7, NULL) may repeat as often as a server has unnamed ports, while
-- (7, 'rcon') may not repeat at all. A port back in the node's free pool is
-- (NULL, 'rcon') and collides with nothing, which is correct — it belongs to
-- no server — and the panel clears the name when a port is handed back anyway.

-- AlterTable
ALTER TABLE "allocations" ADD COLUMN     "role" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "allocations_serverId_role_key" ON "allocations"("serverId", "role");
