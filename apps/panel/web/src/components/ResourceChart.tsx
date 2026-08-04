/**
 * Graphe d'une mesure de ressource.
 *
 * Écrit en SVG plutôt qu'avec une bibliothèque de graphes : trois courbes sans
 * interaction ni zoom ne valent pas les 200 Kio d'un moteur de rendu complet,
 * qu'il faudrait de surcroît charger sur la page la plus consultée du panel.
 *
 * Le tracé est fait dans un repère fixe de 100 × 40 déformé par
 * `preserveAspectRatio="none"` : la courbe s'étire à la largeur disponible sans
 * qu'on ait à mesurer le conteneur. `vector-effect` garde alors une épaisseur de
 * trait constante, sinon l'étirement l'écraserait à l'horizontale.
 */

/** Nombre de points affichés : à un relevé par seconde, une minute d'historique. */
export const CHART_POINTS = 60;

export interface Series {
  label: string;
  points: number[];
  /** Couleur CSS du tracé — les variables du thème sont acceptées. */
  color: string;
  /** Remplit l'aire sous la courbe. Réservé à une série seule. */
  fill?: boolean;
}

export function ResourceChart({
  title,
  series,
  /** Plafond de l'axe vertical. En deçà du maximum observé, celui-ci l'emporte. */
  ceiling = 0,
  format,
}: {
  title: string;
  series: Series[];
  ceiling?: number;
  format: (value: number) => string;
}) {
  // Les séries sont alignées à droite : un point neuf entre par la droite et
  // pousse les autres, comme un moniteur système. Tant qu'il y a moins d'une
  // minute d'historique, le début est comblé par des zéros — la courbe part du
  // plat plutôt que de s'étirer sur toute la largeur puis de se comprimer.
  const padded = series.map((entry) => ({
    ...entry,
    points: [
      ...Array<number>(Math.max(0, CHART_POINTS - entry.points.length)).fill(0),
      ...entry.points.slice(-CHART_POINTS),
    ],
  }));

  const observed = Math.max(0, ...padded.flatMap((entry) => entry.points));
  // Un maximum nul donnerait une division par zéro, et un graphe sans échelle
  // lisible : on garde un plafond strictement positif.
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
        {/* Trois graduations suffisent : le graphe sert à voir une tendance et
            un pic, pas à relever une valeur — celle-ci est dans la carte. */}
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
