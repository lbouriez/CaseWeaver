import type React from "react";

interface CaseWeaverMarkProps {
  readonly size?: number;
  readonly title?: string;
}

export function CaseWeaverMark({
  size = 32,
  title = "CaseWeaver",
}: CaseWeaverMarkProps): React.ReactElement {
  return (
    <svg
      aria-label={title}
      height={size}
      role="img"
      viewBox="0 0 48 48"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <path d="M8 10h32v8H8z" fill="currentColor" opacity="0.22" />
      <path d="M8 20h32v8H8z" fill="currentColor" opacity="0.48" />
      <path d="M8 30h32v8H8z" fill="currentColor" />
      <path d="m16 14 8 8 8-8" fill="none" stroke="white" strokeWidth="3" />
      <path d="m16 24 8 8 8-8" fill="none" stroke="white" strokeWidth="3" />
    </svg>
  );
}
