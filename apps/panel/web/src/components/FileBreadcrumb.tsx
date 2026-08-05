import { Fragment } from 'react';

/**
 * A folder's path, segment by segment.
 *
 * Shared between the listing and the editor: both screens have to place the
 * user the same way, and two implementations would end up diverging on how the
 * root is handled.
 *
 * `/home/container` is the path **inside the container**, not on the host. It
 * is displayed because it is the one found in the server's logs and in the
 * plugins' configuration files: hiding it would force a mental translation
 * between what the panel says and what Minecraft says. `home` is not
 * clickable — nothing exists above the volume.
 */
export function FileBreadcrumb({
  directory,
  file,
  onNavigate,
}: {
  /** Dossier courant, relatif au volume. */
  directory: string;
  /** Name of the open file, appended to the path and not clickable. */
  file?: string;
  onNavigate: (path: string) => void;
}) {
  const segments = directory.split('/').filter(Boolean);

  return (
    <nav aria-label="Path" className="flex flex-wrap items-center gap-1.5 font-mono text-sm">
      <Separator />
      <span className="text-content-subtle">home</span>
      <Separator />

      <button
        type="button"
        className="text-content-muted transition-colors hover:text-content hover:underline"
        onClick={() => onNavigate('/')}
      >
        container
      </button>

      {segments.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          <Separator />
          <button
            type="button"
            className="text-content-muted transition-colors hover:text-content hover:underline"
            onClick={() => onNavigate('/' + segments.slice(0, index + 1).join('/'))}
          >
            {segment}
          </button>
        </Fragment>
      ))}

      {file ? (
        <>
          <Separator />
          {/* The open file ends the path without being a link: it names the
              place one is already in. */}
          <span className="font-semibold text-content">{file}</span>
        </>
      ) : null}
    </nav>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-content-subtle">
      /
    </span>
  );
}
