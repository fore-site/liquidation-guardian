import { useId } from "react";
import { cn } from "../lib/utils.js";

/** The favicon-derived logo mark: dark rounded tile + orange plus. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  const tile = `${id}-tile`;
  const mark = `${id}-mark`;
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={cn("size-8", className)}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1c1c1c" />
          <stop offset="1" stopColor="#0a0a0a" />
        </linearGradient>
        <linearGradient id={mark} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff623e" />
          <stop offset="1" stopColor="#ff3b0e" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="118" fill={`url(#${tile})`} />
      <rect x="3" y="3" width="506" height="506" rx="115" fill="none" stroke="#ffffff" strokeOpacity="0.09" strokeWidth="6" />
      <g fill={`url(#${mark})`}>
        <rect x="232" y="96" width="48" height="320" rx="24" />
        <rect x="96" y="232" width="320" height="48" rx="24" />
      </g>
    </svg>
  );
}

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="flex items-center justify-center rounded-lg" aria-hidden="true">
        <LogoMark className="size-8" />
      </span>
      {!compact && <span className="text-sm font-semibold tracking-tight">Liquidation Guardian</span>}
    </span>
  );
}
