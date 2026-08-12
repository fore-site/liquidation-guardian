import { cn } from "../lib/utils.js";

export function BrandMark({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground" aria-hidden="true">
        LG
      </span>
      {!compact && <span className="text-sm font-semibold tracking-tight">Liquidation Guardian</span>}
    </span>
  );
}
