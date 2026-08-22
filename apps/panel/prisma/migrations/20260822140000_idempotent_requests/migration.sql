-- One provisioning call, remembered so it cannot happen twice.
--
-- Creating a server is the only route of the application API that is not
-- naturally repeatable. Suspending a suspended server is a no-op; deleting a
-- deleted one is a 404; creating twice is two servers, two containers and two
-- invoices. And the call most likely to be repeated is exactly the one that
-- failed halfway — a timeout, a proxy that gave up, a billing system restarted
-- in the middle of a purchase — where the caller cannot tell "it never arrived"
-- from "it arrived and the answer was lost".
--
-- So the caller names its attempt with an `Idempotency-Key`, and the answer to
-- the first attempt is replayed for every repeat of it.
CREATE TABLE "idempotent_requests" (
    "id" SERIAL NOT NULL,
    "applicationKeyId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    -- Digest of the body. A retry has to be the same request: reusing a key
    -- with a different one is a bug in the caller, usually a key derived from
    -- something less unique than they thought, and replaying the first
    -- server's details would hide it until an audit found two customers
    -- sharing a machine.
    "requestHash" TEXT NOT NULL,
    -- Both null while the first attempt is still running. That is what lets a
    -- second call arriving mid-flight be told to wait rather than start a
    -- second server.
    "status" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- A retry window of a day covers every retry a billing system will make.
    -- Keeping them for ever would turn a table nobody reads into the largest
    -- one in the database.
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotent_requests_pkey" PRIMARY KEY ("id")
);

-- Scoped to the key that made the call, and not global: two integrations
-- picking the same value — and `order-1041` is a value both would pick — must
-- not read each other's answers.
CREATE UNIQUE INDEX "idempotent_requests_applicationKeyId_key_key"
    ON "idempotent_requests"("applicationKeyId", "key");

CREATE INDEX "idempotent_requests_expiresAt_idx" ON "idempotent_requests"("expiresAt");

-- Cascade: revoking a key takes its retry window with it. The alternative
-- keeps rows pointing at a credential that no longer exists, for a replay that
-- can no longer authenticate.
ALTER TABLE "idempotent_requests" ADD CONSTRAINT "idempotent_requests_applicationKeyId_fkey"
    FOREIGN KEY ("applicationKeyId") REFERENCES "application_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;
