-- How a template says its servers are ready.
--
-- Nullable and with no default, so the column costs every existing row
-- nothing: they keep a NULL and go on being watched through
-- `startupDetection`, which is what the whole bundled catalogue and every
-- imported Pterodactyl egg declare. Backfilling it would have meant deciding,
-- on behalf of templates whose author never said, that a container being up is
-- the same thing as a server being ready — which is the silent guess this
-- column exists to replace.

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "readiness" JSONB;
