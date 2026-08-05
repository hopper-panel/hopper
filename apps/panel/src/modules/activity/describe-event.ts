import { AUDIT_EVENTS } from '../audit/audit.service.js';

/**
 * Renders an audit entry as a readable sentence.
 *
 * Written server-side and not in the interface, for a simple reason: the
 * sentence depends on the contents of `metadata`, whose shape varies from one
 * event to the next and is known only to whoever writes it. Composing it in the
 * browser would mean publishing that shape and maintaining it in two places —
 * the second soon settling for displaying `server.updated`.
 *
 * The sentences are therefore not translated by the interface's catalogues:
 * they read in English whatever language the reader chose. Moving them would
 * mean publishing every event's metadata shape.
 *
 * An unknown event is not hidden: a technical line beats a hole in a log meant
 * to be exhaustive.
 */

type Metadata = Record<string, unknown>;

function text(metadata: Metadata, key: string): string | null {
  const value = metadata[key];

  return typeof value === 'string' && value !== '' ? value : null;
}

function quoted(value: string | null): string {
  return value === null ? '' : ` "${value}"`;
}

export function describeEvent(event: string, metadata: Metadata): string {
  switch (event) {
    // -- Server --------------------------------------------------------------
    case AUDIT_EVENTS.SERVER_CREATED:
      return 'Created the server.';
    case AUDIT_EVENTS.SERVER_DELETED:
      return 'Deleted the server.';
    case AUDIT_EVENTS.SERVER_SUSPENDED:
      return 'Suspended the server.';
    case AUDIT_EVENTS.SERVER_UNSUSPENDED:
      return 'Reinstated the server.';
    case AUDIT_EVENTS.SERVER_REINSTALLED:
      return 'Reinstalled the server.';

    case AUDIT_EVENTS.SERVER_POWER: {
      const action = text(metadata, 'action');
      const labels: Record<string, string> = {
        start: 'Started the server.',
        stop: 'Stopped the server.',
        restart: 'Restarted the server.',
        kill: 'Killed the server process.',
      };

      return (action && labels[action]) ?? 'Changed the server state.';
    }

    case AUDIT_EVENTS.SERVER_COMMAND:
      return `Ran${quoted(text(metadata, 'command'))} in the console.`;

    // `server.updated` acts as a catch-all for the actions detailed by
    // `metadata.action`: files, startup. Splitting it here avoids having to
    // create one event per file operation.
    case AUDIT_EVENTS.SERVER_UPDATED: {
      // `?? ''` rather than `null`: the `switch` then covers every possible
      // value and `default` stays the only way out.
      const action = text(metadata, 'action') ?? '';

      switch (action) {
        case 'file.write':
          return `Edited the file${quoted(text(metadata, 'file'))}.`;
        case 'file.rename':
          return `Renamed or moved${quoted(text(metadata, 'from'))}.`;
        case 'file.copy':
          return `Copied${quoted(text(metadata, 'from'))}.`;
        case 'file.delete': {
          const files = Array.isArray(metadata.files) ? metadata.files.length : 0;

          return files > 1 ? `Deleted ${files} files.` : 'Deleted a file.';
        }
        case 'file.create-directory':
          return `Created the folder${quoted(text(metadata, 'directory'))}.`;
        case 'file.compress':
          return 'Created an archive.';
        case 'file.decompress':
          return `Extracted the archive${quoted(text(metadata, 'file'))}.`;
        case 'file.chmod':
          return `Changed the permissions to ${text(metadata, 'mode') ?? '?'}.`;
        case 'upload':
          return `Uploaded the file${quoted(text(metadata, 'name'))}.`;
        case 'startup':
          return 'Changed the startup settings.';
        default:
          return 'Changed the server.';
      }
    }

    // -- Backups ---------------------------------------------------------------
    case AUDIT_EVENTS.BACKUP_CREATED:
      // The scheduler and the daemon write this event too: the latter reports
      // a verdict, not a request.
      return metadata.successful === undefined
        ? `Started the backup${quoted(text(metadata, 'name'))}.`
        : metadata.successful === true
          ? 'A backup finished.'
          : 'A backup failed.';
    case AUDIT_EVENTS.BACKUP_DELETED:
      return 'Deleted a backup.';
    case AUDIT_EVENTS.BACKUP_RESTORED:
      return 'Restored a backup.';
    case AUDIT_EVENTS.BACKUP_LOCKED:
      return metadata.locked === true ? 'Locked a backup.' : 'Unlocked a backup.';

    // -- Databases -----------------------------------------------------------
    case AUDIT_EVENTS.DATABASE_CREATED:
      return `Created the database${quoted(text(metadata, 'database'))}.`;
    case AUDIT_EVENTS.DATABASE_UPDATED:
      return `Changed the password of the database${quoted(text(metadata, 'database'))}.`;
    case AUDIT_EVENTS.DATABASE_DELETED:
      return 'Deleted a database.';

    // -- API keys ------------------------------------------------------------
    case AUDIT_EVENTS.API_KEY_CREATED:
      return `Created an API key${quoted(text(metadata, 'memo'))}.`;
    case AUDIT_EVENTS.API_KEY_DELETED:
      return 'Revoked an API key.';

    // -- Outgoing notifications ------------------------------------------------
    case AUDIT_EVENTS.WEBHOOK_CREATED:
      // The URL is in the message: this is a request the panel will now issue
      // on its own, and knowing where to matters as much as knowing who.
      return `Added a notification to${quoted(text(metadata, 'url'))}.`;
    case AUDIT_EVENTS.WEBHOOK_UPDATED:
      return `Changed a notification to${quoted(text(metadata, 'url'))}.`;
    case AUDIT_EVENTS.WEBHOOK_DELETED:
      return 'Deleted a notification.';

    // -- Scheduled tasks -----------------------------------------------------
    case AUDIT_EVENTS.SCHEDULE_CREATED:
      return `Created the scheduled task${quoted(text(metadata, 'name'))}.`;
    case AUDIT_EVENTS.SCHEDULE_UPDATED:
      return metadata.manualRun === true
        ? 'Triggered a scheduled task.'
        : 'Changed a scheduled task.';
    case AUDIT_EVENTS.SCHEDULE_DELETED:
      return 'Deleted a scheduled task.';
    case AUDIT_EVENTS.SCHEDULE_RUN: {
      const failures = Array.isArray(metadata.failures) ? metadata.failures.length : 0;

      return failures === 0
        ? `The task${quoted(text(metadata, 'schedule'))} ran.`
        : `The task${quoted(text(metadata, 'schedule'))} ran with ${failures} failure(s).`;
    }

    // -- Subusers --------------------------------------------------------------
    case AUDIT_EVENTS.SUBUSER_CREATED:
      return 'Gave a user access to the server.';
    case AUDIT_EVENTS.SUBUSER_UPDATED:
      return "Changed a user's permissions.";
    case AUDIT_EVENTS.SUBUSER_DELETED:
      return "Removed a user's access.";

    // -- Panel -----------------------------------------------------------------
    case AUDIT_EVENTS.PANEL_UPDATE_REQUESTED:
      return 'Asked the panel to update itself.';

    default:
      return event;
  }
}
