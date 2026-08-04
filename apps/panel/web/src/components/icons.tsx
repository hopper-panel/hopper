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

/** Connection address. */
export function AddressIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 9a10.5 10.5 0 0 1 15 0" />
      <path d="M7.5 12.5a6.5 6.5 0 0 1 9 0" />
      <path d="M10.5 16a2.5 2.5 0 0 1 3 0" />
      <circle cx="12" cy="19" r="0.6" fill="currentColor" />
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

export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="8" width="18" height="9" rx="1.5" />
      <path d="M7 12v3M11 12v3M15 12v3M19 12v3M6 8V6M18 8V6" />
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

/** Inbound traffic. */
export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 17.5a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.66-1.4A3.75 3.75 0 0 1 17.5 17.5" />
      <path d="M12 10.5v6.5M9.5 14.5 12 17l2.5-2.5" />
    </Icon>
  );
}

/** Outbound traffic. */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 17.5a4 4 0 0 1-.4-7.98 5.5 5.5 0 0 1 10.66-1.4A3.75 3.75 0 0 1 17.5 17.5" />
      <path d="M12 17.5V11M9.5 13.5 12 11l2.5 2.5" />
    </Icon>
  );
}
