import { FACTORIO_TEMPLATES } from './catalog/factorio.js';
import { JAVA_TEMPLATES } from './catalog/java.js';
import { PROXY_TEMPLATES } from './catalog/proxy.js';
import { SOURCE_TEMPLATES } from './catalog/source.js';
import { templateDefinitionSchema, type TemplateDefinition } from './definition.js';

export * from './definition.js';
export * from './pterodactyl-importer.js';
export * from './pterodactyl-exporter.js';
export { JAVA_TEMPLATES } from './catalog/java.js';
export { PROXY_TEMPLATES } from './catalog/proxy.js';
export { FACTORIO_TEMPLATES } from './catalog/factorio.js';
export { SOURCE_TEMPLATES } from './catalog/source.js';

/**
 * Every template shipped with Hopper.
 *
 * Validated when the module loads: a mistake in a definition has to fail the
 * tests, not the seeding of a production instance.
 *
 * The order here is for whoever reads the file — Minecraft first because it is
 * what most of this catalogue is, then the proxies that serve it, then
 * everything else. It is **not** what the interface shows: the panel sorts
 * groups by name (`TemplatesService.listGroups`), so rearranging these spreads
 * changes nothing an operator sees.
 *
 * The spreads are by *family* rather than by game, which is why the Source one
 * arrives holding a single template: `source.ts` owns what an engine does —
 * `srcds_run`, the console on standard input, the anonymous depot — and the
 * second game on it joins that spread instead of adding a line here.
 */
export const TEMPLATE_CATALOG: TemplateDefinition[] = [
  ...JAVA_TEMPLATES,
  ...PROXY_TEMPLATES,
  ...FACTORIO_TEMPLATES,
  ...SOURCE_TEMPLATES,
].map((template) => templateDefinitionSchema.parse(template));

/** Distinct groups present in the catalogue, in order of appearance. */
export function catalogGroups(): string[] {
  return [...new Set(TEMPLATE_CATALOG.map((template) => template.group))];
}
