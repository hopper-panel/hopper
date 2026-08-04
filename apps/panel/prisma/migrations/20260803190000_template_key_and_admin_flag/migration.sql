-- Identifiant stable des templates et protection des personnalisations.
--
-- `key` est unique et non nul, mais la table contient déjà des lignes : la
-- colonne est donc ajoutée en deux temps, avec un remplissage intermédiaire.
-- L'ajouter directement en NOT NULL échouerait sur toute instance existante.

ALTER TABLE "templates" ADD COLUMN "key" TEXT;
ALTER TABLE "templates" ADD COLUMN "modifiedByAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Remplissage des lignes existantes : le nom, réduit à un identifiant.
-- `id` est concaténé pour garantir l'unicité si deux templates portent le même
-- nom dans des groupes différents.
UPDATE "templates"
SET "key" = regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g') || '-' || "id"::text
WHERE "key" IS NULL;

ALTER TABLE "templates" ALTER COLUMN "key" SET NOT NULL;

CREATE UNIQUE INDEX "templates_key_key" ON "templates"("key");
