import { JAVA_TEMPLATES } from './catalog/java.js';
import { PROXY_TEMPLATES } from './catalog/proxy.js';
import { templateDefinitionSchema, type TemplateDefinition } from './definition.js';

export * from './definition.js';
export * from './pterodactyl-importer.js';
export { JAVA_TEMPLATES } from './catalog/java.js';
export { PROXY_TEMPLATES } from './catalog/proxy.js';

/**
 * Every template shipped with Hopper.
 *
 * Validated when the module loads: a mistake in a definition has to fail the
 * tests, not the seeding of a production instance.
 */
export const TEMPLATE_CATALOG: TemplateDefinition[] = [...JAVA_TEMPLATES, ...PROXY_TEMPLATES].map(
  (template) => templateDefinitionSchema.parse(template),
);

/** Distinct groups present in the catalogue, in order of appearance. */
export function catalogGroups(): string[] {
  return [...new Set(TEMPLATE_CATALOG.map((template) => template.group))];
}
