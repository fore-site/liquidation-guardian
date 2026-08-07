import * as React from "react";
import { cn } from "~/lib/utils";

const Badge = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "outline" | "success" | "warning" | "danger" }>(
  ({ className, variant = "default", ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors",
        variant === "default" && "bg-primary text-primary-foreground",
        variant === "secondary" && "bg-secondary text-secondary-foreground",
        variant === "outline" && "border border-border text-foreground",
        variant === "success" && "bg-healthy/15 text-healthy",
        variant === "warning" && "bg-watch/15 text-watch",
        variant === "danger" && "bg-risk/15 text-risk",
        className,
      )}
      {...props}
    />
  ),
);
Badge.displayName = "Badge";

export { Badge };
