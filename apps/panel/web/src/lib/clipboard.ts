/**
 * Copies a text into the clipboard.
 *
 * `navigator.clipboard` exists **only in a secure context**: HTTPS, or
 * `localhost`. A panel served over plain HTTP — an internal install, or before
 * the reverse proxy is in place — therefore has no access to it at all, and a
 * "copy" button relying on it would do nothing, with no visible error.
 *
 * Hence the fallback to `execCommand`, officially deprecated but still
 * implemented everywhere and the only one available outside a secure context.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or an unfocused document: try the fallback.
    }
  }

  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  const holder = document.createElement('textarea');

  holder.value = text;
  // Off screen rather than hidden: an element in `display: none` cannot be
  // selected, and the copy would fail silently.
  holder.style.position = 'fixed';
  holder.style.top = '-1000px';
  holder.setAttribute('readonly', '');

  document.body.appendChild(holder);

  try {
    holder.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(holder);
  }
}
