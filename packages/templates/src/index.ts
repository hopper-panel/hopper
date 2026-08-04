import { JAVA_TEMPLATES } from './catalog/java.js';
import { PROXY_TEMPLATES } from './catalog/proxy.js';
import { templateDefinitionSchema, type TemplateDefinition } from './definition.js';

export * from './definition.js';
export * from './pterodactyl-importer.js';
export { JAVA_TEMPLATES } from './catalog/java.js';
export { PROXY_TEMPLATES } from './catalog/proxy.js';

/**
 * Tous les templates livrés avec Hopper.
 *
 * Validés au chargement du module : une faute dans une définition doit faire
 * échouer les tests, pas l'amorçage d'une instance en production.
 */
export const TEMPLATE_CATALOG: TemplateDefinition[] = [...JAVA_TEMPLATES, ...PROXY_TEMPLATES].map(
  (template) => templateDefinitionSchema.parse(template),
);

/** Groupes distincts présents dans le catalogue, dans leur ordre d'apparition. */
export function catalogGroups(): string[] {
  return [...new Set(TEMPLATE_CATALOG.map((template) => template.group))];
}
