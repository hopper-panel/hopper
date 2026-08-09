-- What a template needs before an administrator can write one by hand.
--
-- Everything a Pterodactyl egg carries already has a column: the install
-- script, the config files, the readiness strategy, the structured stop, the
-- variables and their rules. What is missing is not the shape of a template but
-- the shape of *editing* one — an order for the variables, a name that cannot
-- collide inside its own group, and somebody to ask about a group.

-- Who to ask about the templates in a group.
--
-- Never imported and never exported, because there is nothing to import it
-- from: an egg carries an `author` of its own and says nothing about its
-- parent. Across the 274 eggs of the public corpus the string "nest" does not
-- appear once — the parent is chosen by the administrator at import time, which
-- is what Hopper already does. So this is a note the operator writes for the
-- next operator, and it is empty until somebody writes it.
ALTER TABLE "template_groups" ADD COLUMN     "author" TEXT NOT NULL DEFAULT '';

-- When the group last changed, which only becomes answerable now.
--
-- Added with a default and then stripped of it, so that the existing rows are
-- backfilled with the moment of the migration while the column ends up matching
-- what `@updatedAt` means everywhere else in this schema: NOT NULL, no default,
-- written by the client on every update. A default left in place would silently
-- keep working and would drift the moment somebody generated a migration from
-- the schema.
ALTER TABLE "template_groups" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "template_groups" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- Where a variable sits on the Startup page.
--
-- Zero for every existing row, which is the point rather than a shortcut. Ties
-- are broken by `id`, so a template whose variables all sit at 0 keeps exactly
-- the order it has today; only a template somebody has actually reordered
-- carries anything else. Not unique, because an editor renumbering a whole list
-- writes 0,1,2,3 over 0,1,2,3 and would otherwise collide with itself halfway
-- through.
ALTER TABLE "template_variables" ADD COLUMN     "sort" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "template_variables_templateId_sort_idx" ON "template_variables"("templateId", "sort");

-- Two templates in one group can no longer share a name.
--
-- `key` is unique and is what the catalogue upserts on, so nothing was
-- structurally wrong before; what was wrong is what an administrator sees. A
-- group listing two entries both called "Paper" gives no way to tell which one
-- a server is running, and an editor makes that easy to produce by accident
-- rather than difficult.
--
-- The rename below runs first and is what stops this migration failing on a
-- panel that already holds a collision — an import is one click and nothing has
-- ever refused a duplicate name. The oldest row of each collision keeps the
-- name it has; the rest gain their own `key` in brackets, which is unique
-- globally and is therefore unique here. Renaming rather than refusing, because
-- a migration that aborts on a duplicate leaves an operator with a panel that
-- will not start and a constraint they cannot see to fix.
UPDATE "templates" AS t
SET "name" = t."name" || ' (' || t."key" || ')'
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "groupId", "name" ORDER BY "id") AS "rank"
  FROM "templates"
) AS d
WHERE d."id" = t."id" AND d."rank" > 1;

CREATE UNIQUE INDEX "templates_groupId_name_key" ON "templates"("groupId", "name");
