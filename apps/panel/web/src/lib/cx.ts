/**
 * Joins CSS classes, ignoring falsy conditional values.
 *
 * In its own module rather than in `components/ui.tsx`: a file exporting both
 * components and functions breaks Vite's hot reload.
 */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
