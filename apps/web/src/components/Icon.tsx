const PATHS = {
  play: "M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  previous:
    "M6 5h2v14H6zM19 5.8v12.4a.8.8 0 0 1-1.24.67L9.5 13.2a1.4 1.4 0 0 1 0-2.4l8.26-5.67A.8.8 0 0 1 19 5.8Z",
  next: "M16 5h2v14h-2zM5 5.8v12.4a.8.8 0 0 0 1.24.67l8.26-5.67a1.4 1.4 0 0 0 0-2.4L6.24 5.13A.8.8 0 0 0 5 5.8Z",
  replay: "M12 5V2L7.5 6 12 10V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z",
  back: "M15.5 5.5 9 12l6.5 6.5-1.4 1.4L6.2 12l7.9-7.9z",
  bookmark: "M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Zm1 2v12.3l4-2.7 4 2.7V5H8Z",
  bookmarkFilled: "M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Z",
  edit: "m14.06 6.19 3.75 3.75L8.75 19H5v-3.75l9.06-9.06Zm1.41-1.41 1.83-1.83a1 1 0 0 1 1.41 0l2.34 2.34a1 1 0 0 1 0 1.41l-1.83 1.83-3.75-3.75Z",
  download: "M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V4ZM5 18h14v2H5z",
  copy: "M10 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2v-2h1V5h-8v1H9V4a1 1 0 0 1 1-1ZM5 8h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Zm1 2v9h7v-9H6Z",
  check: "M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z",
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
