/**
 * Chart of one resource measurement.
 *
 * Written in SVG rather than with a charting library: three curves with no
 * interaction and no zoom are not worth the 200 KiB of a full rendering engine,
 * which would on top of that have to load on the panel's most visited page.
 *
 * The path is drawn in a fixed 100 × 40 frame distorted by
 * `preserveAspectRatio="none"`: the curve stretches to the available width with
 * no need to measure the container. `vector-effect` then keeps the stroke width
 * constant, otherwise the stretching would flatten it horizontally.
 */

/** Number of points shown: at one sample a second, a minute of history. */
export const CHART_POINTS = 60;

export interface Series {
  label: string;
  points: number[];
  /** CSS colour of the stroke — theme variables are accepted. */
  color: string;
  /** Fills the area under the curve. For a lone series only. */
  fill?: boolean;
}

export function ResourceChart({
  title,
  series,
  /** Ceiling of the vertical axis. Below the observed maximum, that one wins. */
  ceiling = 0,
  format,
}: {
  title: string;
  series: Series[];
  ceiling?: number;
  format: (value: number) => string;
}) {
  // The series are right-aligned: a new point enters from the right and pushes
  // the others along, like a system monitor. While there is less than a minute
  // of history, the start is padded with zeros — the curve begins flat rather
  // than stretching across the full width then compressing.
  const padded = series.map((entry) => ({
    ...entry,
    points: [
      ...Array<number>(Math.max(0, CHART_POINTS - entry.points.length)).fill(0),
      ...entry.points.slice(-CHART_POINTS),
    ],
  }));

  const observed = Math.max(0, ...padded.flatMap((entry) => entry.points));
  // A zero maximum would give a division by zero, and a chart with no readable
  // scale: the ceiling is kept strictly positive.
  const max = Math.max(ceiling, observed, Number.EPSILON);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface-raised p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-content">{title}</h3>

        {series.length > 1 ? (
          <div className="flex items-center gap-3">
            {series.map((entry) => (
              <span
                key={entry.label}
                className="flex items-center gap-1.5 text-xs text-content-muted"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="relative mt-3 h-36">
        {/* Three gridlines are enough: the chart is there to show a trend and
            a spike, not to read a value off — that is in the card. */}
        <div className="absolute inset-y-0 left-0 flex w-16 flex-col justify-between text-right text-[10px] tabular-nums text-content-subtle">
          <span>{format(max)}</span>
          <span>{format(max / 2)}</span>
          <span>{format(0)}</span>
        </div>

        <svg
          className="absolute inset-y-0 right-0 left-[4.5rem] h-full w-[calc(100%-4.5rem)]"
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title} — ${series.map((entry) => `${entry.label} : ${format(entry.points.at(-1) ?? 0)}`).join(', ')}`}
        >
          <line
            x1="0"
            y1="20"
            x2="100"
            y2="20"
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
            className="text-border-subtle/60"
          />

          {padded.map((entry) => (
            <g key={entry.label}>
              {entry.fill ? (
                <path d={areaPath(entry.points, max)} fill={entry.color} fillOpacity={0.15} />
              ) : null}
              <path
                d={linePath(entry.points, max)}
                fill="none"
                stroke={entry.color}
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}

function coordinates(points: number[], max: number): string {
  const step = 100 / Math.max(1, points.length - 1);

  return points
    .map((value, index) => `${(index * step).toFixed(2)},${(40 - (value / max) * 40).toFixed(2)}`)
    .join(' L');
}

function linePath(points: number[], max: number): string {
  return `M${coordinates(points, max)}`;
}

function areaPath(points: number[], max: number): string {
  return `M0,40 L${coordinates(points, max)} L100,40 Z`;
}
