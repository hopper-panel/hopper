-- A credential for the software a hosting provider runs beside the panel.
--
-- Personal API keys already exist and are the wrong shape for this. One of them
-- borrows its owner's access: it opens exactly the servers that person opens,
-- and it stops working the day they are demoted, suspended or deleted. That is
-- the right behaviour for a key somebody pastes into a script, and the wrong
-- one for the credential a billing system provisions customers with — an
-- administrator leaving the company must not be the reason a paid-for server is
-- never delivered.
--
-- So this key belongs to nobody. `created_by_id` records who made it, for the
-- trail, and is nulled rather than cascaded when that account goes: the note
-- disappears, the key does not.
--
-- `revoked_at` rather than a deletion, for the same reason the audit log keeps
-- rows nobody will read again: a key that provisioned two hundred servers has
-- to stay nameable afterwards, and a deleted row names nothing.
CREATE TABLE "application_keys" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "allowedIps" TEXT[],
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,

    CONSTRAINT "application_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "application_keys_uuid_key" ON "application_keys"("uuid");

-- The identifier is what an incoming request is looked up by, on every call.
CREATE UNIQUE INDEX "application_keys_identifier_key" ON "application_keys"("identifier");

CREATE INDEX "application_keys_createdById_idx" ON "application_keys"("createdById");

ALTER TABLE "application_keys" ADD CONSTRAINT "application_keys_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
