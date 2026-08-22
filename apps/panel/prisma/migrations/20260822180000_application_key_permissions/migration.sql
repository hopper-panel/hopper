-- One decision per resource, instead of one for the whole API.
--
-- Application keys shipped with two scopes, `read` and `write`, applied to
-- everything they could reach. That is too coarse for what people actually run
-- beside a panel. A billing system creates and deletes servers; a status page
-- counts them; an internal dashboard reads the estate. Handing the status page
-- a credential that can delete a customer's world — because it also needed to
-- list plans — is not a trade anybody would make knowingly, and the old shape
-- offered no other.
--
-- The column is renamed as well as reinterpreted. `scopes` holding
-- `servers:write` would read like a scope with a colon in it, and the next
-- person to write a query against it would have to find out otherwise.
ALTER TABLE "application_keys" RENAME COLUMN "scopes" TO "permissions";

-- Existing keys keep exactly what they could do, spelled out.
--
-- `write` implied read, so it becomes `write` on every resource; `read` becomes
-- `read` on every resource. A key holding both said `write` about writes and
-- `read` about reads, which is the same thing as `write` — so `write` wins, and
-- the CASE below is ordered accordingly.
--
-- Widening nothing and narrowing nothing is the point: an upgrade must not
-- break a provisioning integration at three in the morning, and must not
-- quietly hand a status page more than it had.
UPDATE "application_keys"
SET "permissions" = CASE
    WHEN 'write' = ANY("permissions") THEN ARRAY[
        'servers:write', 'users:write', 'plans:read',
        'nodes:read', 'allocations:read', 'templates:read'
    ]
    WHEN 'read' = ANY("permissions") THEN ARRAY[
        'servers:read', 'users:read', 'plans:read',
        'nodes:read', 'allocations:read', 'templates:read'
    ]
    -- A key with neither could reach nothing, and still cannot.
    ELSE ARRAY[]::TEXT[]
END;
