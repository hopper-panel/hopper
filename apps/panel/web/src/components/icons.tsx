import type { SVGProps } from 'react';

/**
 * The panel's icon set.
 *
 * Drawn by hand rather than imported from a library: seven are needed, and an
 * icon dependency weighs more than this file. They all follow the same grid of
 * 24, a stroke of 1.5 and `currentColor`, so they drop into any block with no
 * adjustment.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/**
 * Connection address.
 *
 * A globe, not the wifi arcs this used to draw: the field holds `host:port`,
 * which is where a player connects from anywhere — nothing to do with a radio
 * link. The arcs also thinned to almost nothing at the top of their sweep.
 */
export function AddressIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="4" ry="8.5" />
      <path d="M3.5 12h17" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </Icon>
  );
}

export function CpuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </Icon>
  );
}

/**
 * Memory.
 *
 * The contact pins sit below the body. They used to be drawn inside it, ending
 * mid-board, which read as a chip with four stray marks across it rather than
 * as a module — and two stubs floated above the top edge, attached to nothing.
 */
export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="7" width="19" height="8" rx="1.5" />
      <path d="M7 10.5v1.5M12 10.5v1.5M17 10.5v1.5" />
      <path d="M7 15v2.5M12 15v2.5M17 15v2.5" />
    </Icon>
  );
}

export function DiskIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="3" />
      <path d="M4.5 6.5v11c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-11" />
      <path d="M19.5 12c0 1.66-3.36 3-7.5 3s-7.5-1.34-7.5-3" />
    </Icon>
  );
}

/**
 * Inbound traffic.
 *
 * An arrow onto a line, not the cloud these used to draw. That cloud's outline
 * never closed — the path ran from one lower corner to the other with nothing
 * along the bottom — so at the 20px these render at, it showed as an arc with
 * two loose ends, and the arrow crossed the gap. A cloud also says "remote
 * storage", where the figure means bytes over the wire.
 */
export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5v11" />
      <path d="M7.5 10 12 14.5 16.5 10" />
      <path d="M4.5 18.5h15" />
    </Icon>
  );
}

/** Outbound traffic. Mirrors the inbound arrow so the pair reads as one. */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 14.5v-11" />
      <path d="M7.5 8 12 3.5 16.5 8" />
      <path d="M4.5 18.5h15" />
    </Icon>
  );
}
