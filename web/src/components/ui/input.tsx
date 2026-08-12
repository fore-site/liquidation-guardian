import * as React from "react";
import { cn } from "~/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) => <input type={type} className={cn("flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground transition-colors duration-300 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50 hover:border-[#555]", className)} ref={ref} {...props} />);
Input.displayName = "Input";
export { Input };
