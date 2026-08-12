import * as React from "react";
import { cn } from "~/lib/utils";

const Badge = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "outline" | "success" | "warning" | "danger" }>(({ className, variant = "default", ...props }, ref) => <span ref={ref} className={cn("inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-wider", variant === "default" && "border-primary/40 bg-primary/10 text-accent", variant === "secondary" && "border-border bg-secondary text-muted-foreground", variant === "outline" && "border-border text-foreground", variant === "success" && "border-healthy/40 bg-healthy/10 text-healthy", variant === "warning" && "border-watch/40 bg-watch/10 text-watch", variant === "danger" && "border-risk/40 bg-risk/10 text-risk", className)} {...props} />);
Badge.displayName = "Badge";
export { Badge };
