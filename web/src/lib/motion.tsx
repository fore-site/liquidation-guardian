import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./utils";

/**
 * IntersectionObserver hook — fires once when the element enters the viewport.
 * Never uses a scroll listener (landing-page-design B7).
 */
export function useInView<T extends HTMLElement>(threshold = 0.2) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);

  return { ref, inView };
}

/** Gentle heavy fade-up on scroll entry (B7): translate-y-16 blur → settle. */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "li" | "span";
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <Tag
      ref={ref as never}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "fluid will-change-transform",
        inView ? "translate-y-0 opacity-100 blur-0" : "translate-y-16 opacity-0 blur-md",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * Word-by-word tagline reveal (B11): each word goes from ~30% opacity to full
 * color as the section crosses the trigger line, in reading order.
 */
export function TaglineReveal({ text, className }: { text: string; className?: string }) {
  const { ref, inView } = useInView<HTMLParagraphElement>(0.4);
  const words = text.split(" ");
  return (
    <p
      ref={ref}
      aria-label={text}
      className={cn("text-balance", className)}
    >
      {words.map((w, i) => (
        <span
          key={i}
          aria-hidden="true"
          className="fluid inline-block"
          style={{
            opacity: inView ? 1 : 0.3,
            transitionDelay: `${i * 40}ms`,
          }}
        >
          {w}
          {i < words.length - 1 ? "\u00A0" : ""}
        </span>
      ))}
    </p>
  );
}
