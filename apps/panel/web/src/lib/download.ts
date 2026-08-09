/**
 * Saving a value the panel already has as a file.
 *
 * The alternative — pointing an `<a download>` at the API — is shorter and
 * wrong here, and the reason is `api.ts`: the panel's HTTP client silently
 * renews an expired access token on a 401 and retries. A browser following a
 * link does none of that, so the operator whose token had just lapsed would be
 * handed a file containing `{"message":"Unauthorized"}`, named as though it
 * were their template. Fetching through the client and building the file here
 * keeps the one path that knows how to stay signed in.
 *
 * Two spaces of indentation rather than none, because the file's next reader is
 * usually a person: an exported template is something an operator diffs against
 * another installation's, or edits by hand before importing it somewhere else.
 */
export function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  // The blob is held by the document until it is revoked, and a page an
  // operator exports twenty templates from would otherwise hold twenty copies
  // of them until it was closed.
  URL.revokeObjectURL(url);
}
