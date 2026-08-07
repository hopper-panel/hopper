-- How a template stops its servers, when two words and a colon cannot say it.
--
-- `stopCommand` holds `command:stop` or `signal:SIGTERM` and stays exactly
-- where it is: it is what the whole bundled catalogue and every imported
-- Pterodactyl egg declares, and a row that keeps a NULL here goes on being
-- decoded from it, byte for byte as before. An RCON stop is three fields — the
-- command, the variable holding the password, the name of the port to send it
-- to — and there is no colon encoding of those that survives a password with a
-- colon in it.
--
-- Nullable with no default, therefore, and not a backfill: filling it in would
-- mean deciding on behalf of templates whose author never said which transport
-- their game answers on, and the wrong answer there is a stop that reaches
-- nobody and a SIGKILL through the save.

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "stop" JSONB;

-- How long that stop is given before the SIGKILL.
--
-- The contract has carried `stopTimeoutSeconds` since the first release with a
-- default of 30 and no way for a template to set it, so every server ever
-- created runs on that figure. It is a Minecraft one — a Bukkit server flushes
-- its regions in a second or two — and it is the wrong one for a game that
-- writes its entire world on shutdown, which is exactly the kind of game the
-- column above exists for.
--
-- NULL means "this template did not say" and the panel supplies the same 30 it
-- always did. That distinction is why there is no DEFAULT 30 here: a stored 30
-- would be a template's own decision, indistinguishable from silence, and the
-- day the contract's default is reconsidered every row would be holding an
-- opinion nobody expressed.
ALTER TABLE "templates" ADD COLUMN     "stopTimeoutSeconds" INTEGER;
