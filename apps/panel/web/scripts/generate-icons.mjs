// Regenerates src/components/icons.tsx from Material Symbols.
//
//   pnpm --filter @hopper/web icons
//
// The paths are inlined into a committed file rather than loaded at runtime.
// The usual integration is a stylesheet from fonts.googleapis.com, which is
// wrong for a panel people run themselves: every operator's browser would
// announce to Google when they open it, and an installation on a private
// network — which plenty are — would show no icons at all. Inlining costs a few
// kilobytes in the bundle and owes nobody a request.
//
// @material-symbols/svg-400 is a devDependency for the same reason: it weighs
// 13 MB and never reaches the browser.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'node_modules', '@material-symbols', 'svg-400', 'outlined');
const target = join(here, '..', 'src', 'components', 'icons.tsx');

/**
 * Component name → Material Symbols name.
 *
 * Every entry earns its choice: `developer_board` for the processor rather than
 * `memory`, which Material uses for a RAM stick and which would have made the
 * two cards identical.
 */
const ICONS = {
  // Navigation
  DashboardIcon: 'dashboard',
  SettingsIcon: 'settings',
  NodesIcon: 'dns',
  ServersIcon: 'storage',
  UsersIcon: 'group',
  DatabaseIcon: 'database',
  TemplatesIcon: 'deployed_code',
  SearchIcon: 'search',
  LanguageIcon: 'language',
  LogoutIcon: 'power_settings_new',
  // Paging through a list. `chevron` rather than `arrow`: Material's arrows are
  // heavier and read as "go back a page in the browser" next to a page number.
  PreviousIcon: 'chevron_left',
  NextIcon: 'chevron_right',

  // Server statistics
  AddressIcon: 'lan',
  ClockIcon: 'schedule',
  CpuIcon: 'developer_board',
  MemoryIcon: 'memory',
  DiskIcon: 'hard_drive',
  DownloadIcon: 'download',
  UploadIcon: 'upload',

  // File manager and tables
  EditIcon: 'edit',
  RenameIcon: 'edit_square',
  CopyIcon: 'content_copy',
  KeyIcon: 'key',
  CompressIcon: 'folder_zip',
  ExtractIcon: 'unarchive',
  DeleteIcon: 'delete',
};

function pathOf(name) {
  const svg = readFileSync(join(source, `${name}.svg`), 'utf8');
  const match = /<path d="([^"]+)"/.exec(svg);

  if (!match) {
    throw new Error(`No path found in ${name}.svg`);
  }

  return match[1];
}

const header = `import type { SVGProps } from 'react';

/**
 * The panel's icon set.
 *
 * Generated from Material Symbols (Apache-2.0) by \`scripts/generate-icons.mjs\`
 * — do not edit by hand, run \`pnpm --filter @hopper/web icons\`.
 *
 * The paths are inlined rather than loaded from fonts.googleapis.com. A panel
 * people run themselves should not make every operator's browser announce to
 * Google when they open it, and an installation on a private network would show
 * no icons at all.
 *
 * These replaced a set of Unicode characters — \`⌂ ⚙ ▦ ▤ ◍ ◫ ❐ ⚿ ⧉ ✎\` — whose
 * appearance depended on whichever font the visitor happened to have. Several
 * had no relation to what they labelled, and the rarer ones rendered as a box
 * on systems that did not carry them.
 *
 * Material's grid is 960 wide with the origin at the baseline, hence the
 * viewBox. They are filled shapes, not strokes: setting \`stroke\` on them does
 * nothing.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden {...props}>
      {children}
    </svg>
  );
}
`;

const body = Object.entries(ICONS)
  .map(
    ([component, name]) => `
/** Material Symbols \`${name}\`. */
export function ${component}(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="${pathOf(name)}" />
    </Icon>
  );
}
`,
  )
  .join('');

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${header}${body}`, 'utf8');

console.log(`${Object.keys(ICONS).length} icons written to ${target}`);
