const PATHS = {
  play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  previous:
    "M6 5h2v14H6zM19 5.8v12.4a.8.8 0 0 1-1.24.67L9.5 13.2a1.4 1.4 0 0 1 0-2.4l8.26-5.67A.8.8 0 0 1 19 5.8Z",
  next: "M16 5h2v14h-2zM5 5.8v12.4a.8.8 0 0 0 1.24.67l8.26-5.67a1.4 1.4 0 0 0 0-2.4L6.24 5.13A.8.8 0 0 0 5 5.8Z",
  replay: "M12 5V2L7.5 6 12 10V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z",
  back: "M15.5 5.5 9 12l6.5 6.5-1.4 1.4L6.2 12l7.9-7.9z",
} as const;

export type IconName = keyof typeof PATHS;

/** Decorative icon; give the surrounding control an accessible label. */
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
