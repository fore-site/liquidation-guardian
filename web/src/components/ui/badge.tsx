import * as React from "react";
import { cn } from "~/lib/utils";

const Badge = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "outline" | "success" | "warning" | "danger" }
>(({ className, variant = "default", ...props }, ref) => (
  <span
    ref={ref}
    className={cn(
      "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-wider transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
      variant === "default" && "bg-primary/15 text-accent border border-primary/20",
      variant === "secondary" && "bg-secondary text-secondary-foreground border border-border",
      variant === "outline" && "border border-border text-foreground bg-transparent hover:bg-secondary",
      variant === "success" && "bg-healthy/15 text-healthy border border-healthy/20",
      variant === "warning" && "bg-watch/15 text-watch border border-watch/20",
      variant === "danger" && "bg-risk/15 text-risk border border-risk/20",
      className,
    )}
    {...props}
  />
));
Badge.displayName = "Badge";

export { Badge };
