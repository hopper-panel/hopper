/**
 * What a template can load, by its key.
 *
 * `vanilla` is absent on purpose, and that absence is the feature: a vanilla
 * server reads neither `plugins/` nor `mods/`. Without this the panel happily
 * installed a Fabric mod onto one — the file landed in the right folder for
 * Fabric, on a server with no loader to read it, and nothing anywhere said so.
 *
 * Read by two places that must agree: the plugin routes, which refuse a server
 * absent from it, and the server summary, which tells the interface whether to
 * show the Plugins tab at all. A second copy of this table is how the tab would
 * come to lead somewhere that only says no.
 */
const LOADER_FOR_TEMPLATE: Record<string, string> = {
  paper: 'paper',
  purpur: 'purpur',
  fabric: 'fabric',
  neoforge: 'neoforge',
  velocity: 'velocity',
  bungeecord: 'bungeecord',
};

/** The loader a template runs, or `null` when it loads neither plugins nor mods. */
export function pluginLoaderFor(templateKey: string): string | null {
  return LOADER_FOR_TEMPLATE[templateKey] ?? null;
}
