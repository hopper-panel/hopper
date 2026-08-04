-- Stable template identifier, and protection for customisations.
--
-- `key` is unique and not null, but the table already holds rows: the column is
-- therefore added in two steps, with a backfill in between. Adding it straight
-- as NOT NULL would fail on any existing instance.

ALTER TABLE "templates" ADD COLUMN "key" TEXT;
ALTER TABLE "templates" ADD COLUMN "modifiedByAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Backfill of the existing rows: the name, reduced to an identifier. `id` is
-- appended to guarantee uniqueness if two templates carry the same name in
-- different groups.
UPDATE "templates"
SET "key" = regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g') || '-' || "id"::text
WHERE "key" IS NULL;

ALTER TABLE "templates" ALTER COLUMN "key" SET NOT NULL;

CREATE UNIQUE INDEX "templates_key_key" ON "templates"("key");
