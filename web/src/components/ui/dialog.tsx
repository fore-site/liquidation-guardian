import * as React from "react";
import { cn } from "~/lib/utils";

export function Dialog({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previous; };
  }, [open, onOpenChange]);
  if (!open) return null;
  return <div role="presentation" className="fixed inset-0 z-[99] flex items-center justify-center bg-black/80 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onOpenChange(false); }}>{children}</div>;
}

export const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => <div ref={ref} role="dialog" aria-modal="true" className={cn("w-full max-w-lg rounded-xl border border-border bg-card p-6", className)} {...props} />);
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("space-y-2", className)} {...props} />;
export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, ...props }, ref) => <h2 ref={ref} className={cn("text-xl font-medium tracking-tight", className)} {...props} />);
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
