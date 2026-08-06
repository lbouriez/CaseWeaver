import type React from "react";

interface GitHubMarkProps {
  readonly size?: number;
}

export function GitHubMark({ size = 20 }: GitHubMarkProps): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 1.75a10.25 10.25 0 0 0-3.24 19.98c.51.09.7-.22.7-.49v-1.92c-2.86.62-3.46-1.21-3.46-1.21-.47-1.18-1.14-1.5-1.14-1.5-.93-.64.07-.63.07-.63 1.03.07 1.57 1.05 1.57 1.05.91 1.56 2.4 1.11 2.98.85.09-.66.36-1.11.65-1.36-2.28-.26-4.68-1.14-4.68-5.07 0-1.12.4-2.03 1.05-2.75-.1-.26-.45-1.3.1-2.71 0 0 .86-.28 2.82 1.05A9.77 9.77 0 0 1 12 6.68c.87 0 1.75.12 2.57.35 1.96-1.33 2.81-1.05 2.81-1.05.56 1.41.21 2.45.11 2.71.65.72 1.04 1.63 1.04 2.75 0 3.94-2.41 4.8-4.7 5.06.37.32.7.94.7 1.9v2.82c0 .27.18.59.71.49A10.25 10.25 0 0 0 12 1.75Z"
        fill="currentColor"
      />
    </svg>
  );
}
