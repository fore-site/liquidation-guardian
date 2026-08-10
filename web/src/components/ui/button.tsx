import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 relative overflow-hidden [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_4px_24px_rgba(124,92,252,0.35)] hover:shadow-[0_6px_32px_rgba(124,92,252,0.45)]",
        destructive: "bg-destructive text-white hover:bg-destructive/90 shadow-[0_4px_24px_rgba(217,48,37,0.35)]",
        outline: "border border-border bg-transparent text-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-primary",
        secondary: "bg-secondary text-secondary-foreground hover:bg-input",
        ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 py-2.5", // slightly taller, more generous
        sm: "h-9 rounded-full px-4 text-xs",
        lg: "h-13 rounded-full px-9 text-base", // main buttons text-base semibold
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** When true and the button has a trailing icon (svg), wraps the icon in the magnetic inner wrapper. */
  magneticIcon?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, magneticIcon = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const childArray = React.Children.toArray(children);
    const hasTrailingIcon = childArray.length > 1 && React.isValidElement(childArray[childArray.length - 1]);
    
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      >
        {children}
        {magneticIcon && hasTrailingIcon && (
          <span className="btn-icon-wrapper" aria-hidden="true">
            {childArray[childArray.length - 1]}
          </span>
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
