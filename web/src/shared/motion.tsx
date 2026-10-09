import type { CSSProperties, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/*
 * Motion primitives for the burgundy & cream library theme.
 * Everything is plain CSS + the Web Animations API; every animation is skipped
 * (final state shown immediately) when the user prefers reduced motion.
 */

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export const easing = {
  out: "cubic-bezier(.2, .9, .3, 1)",
  spring: "cubic-bezier(.2, 1.15, .4, 1)",
  rise: "cubic-bezier(.2, .9, .3, 1.2)",
  page: "cubic-bezier(.2, .8, .2, 1)",
  heavy: "cubic-bezier(.6, .05, .2, 1)"
} as const;

export function prefersReducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;
}

export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** element.animate() that does nothing under reduced motion or without WAAPI support. */
export function animate(element: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (!element || typeof element.animate !== "function" || prefersReducedMotion()) return null;
  return element.animate(keyframes, options);
}

/** Children of `ref` fade up one after another whenever `deps` change. */
export function useStagger(ref: RefObject<HTMLElement | null>, deps: unknown[], { step = 60, delay = 0, distance = 18, duration = 500 } = {}) {
  useLayoutEffect(() => {
    const items = Array.from(ref.current?.children ?? []);
    const animations = items.map((item, index) =>
      animate(item, [{ opacity: 0, transform: `translateY(${distance}px)` }, { opacity: 1, transform: "none" }], {
        duration,
        delay: delay + index * step,
        easing: easing.out,
        fill: "backwards"
      })
    );
    return () => animations.forEach((animation) => animation?.cancel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

const SPINE_COLORS = ["var(--burgundy)", "var(--blush)", "var(--wood)", "var(--rose)", "var(--burgundy-deep)", "var(--line)", "#C98A6B"];
const SPINE_HEIGHTS = [34, 26, 38, 30, 40, 24, 36, 32];

/** A shelf of book spines on a wooden ledge: they rise in a stagger and lift under the cursor. */
export function BookSpinesBand({ count = 44, height = 46, className = "" }: { count?: number; height?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const scale = height / 46;

  useLayoutEffect(() => {
    const spines = Array.from(ref.current?.children ?? []);
    const animations = spines.map((spine, index) =>
      animate(spine, [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 700, delay: index * 30, easing: easing.rise, fill: "backwards" })
    );
    return () => animations.forEach((animation) => animation?.cancel());
  }, [count]);

  return (
    <div ref={ref} className={`qa-spines-band ${className}`} style={{ "--band-height": `${height}px` } as CSSProperties} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <i
          key={index}
          style={{
            height: `${Math.round((SPINE_HEIGHTS[index % 8] + ((index * 7) % 9)) * scale)}px`,
            background: SPINE_COLORS[(index * 3) % SPINE_COLORS.length]
          }}
        />
      ))}
    </div>
  );
}

/** Renders children in a container and fades them up in sequence; change `replayKey` to replay. */
export function StaggerList({
  as: Tag = "div",
  children,
  replayKey,
  step,
  delay,
  className = ""
}: {
  as?: "div" | "ul" | "ol";
  children: ReactNode;
  replayKey?: unknown;
  step?: number;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useStagger(ref, [replayKey], { step, delay });
  return <Tag ref={ref as never} className={className}>{children}</Tag>;
}

/** Counts from the previous value (0 on first view) to `value` once the number scrolls into view. */
export function CountUp({
  value,
  duration = 1200,
  decimals = 0,
  suffix = "",
  locale,
  className = ""
}: {
  value: number;
  duration?: number;
  decimals?: number;
  suffix?: string;
  locale?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const [display, setDisplay] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.3 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const from = shown.current;
    if (prefersReducedMotion() || from === value) {
      shown.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      shown.current = from + (value - from) * eased;
      setDisplay(shown.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, visible, duration]);

  const format = (number: number) => number.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;

  return (
    <span ref={ref} className={`font-tabular ${className}`}>
      <span aria-hidden="true">{format(display)}</span>
      <span className="qa-sr-only">{format(value)}</span>
    </span>
  );
}

/** Wraps a step of a flow; when `turnKey` changes the new content turns in like a page. */
export function PageTurn({ turnKey, direction = "forward", children, className = "" }: { turnKey: unknown; direction?: "forward" | "back"; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastKey = useRef(turnKey);

  useLayoutEffect(() => {
    if (lastKey.current === turnKey) return;
    lastKey.current = turnKey;
    const sign = direction === "forward" ? 1 : -1;
    const animation = animate(
      ref.current,
      [
        { opacity: 0, transform: `perspective(900px) rotateY(${-14 * sign}deg) translateX(${18 * sign}px)` },
        { opacity: 1, transform: "none" }
      ],
      { duration: 550, easing: easing.page }
    );
    return () => animation?.cancel();
  }, [turnKey, direction]);

  return <div ref={ref} className={`qa-page-turn ${direction === "back" ? "is-back" : ""} ${className}`}>{children}</div>;
}

/** A catalogue card that slides up out of a wooden card-catalogue drawer. */
export function CatalogDrawer({ open = true, label, children, className = "" }: { open?: boolean; label: ReactNode; children: ReactNode; className?: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const from = useRef<string | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const hidden = `translateY(${card.offsetHeight + 32}px)`;
    const target = open ? "translateY(0px)" : hidden;
    const current = !from.current || from.current === "none" ? (from.current ? "translateY(0px)" : hidden) : from.current;
    card.style.transform = target;
    const animation = animate(card, [{ transform: current }, { transform: target }], {
      duration: open ? 900 : 480,
      easing: open ? easing.spring : easing.heavy
    });
    return () => {
      // Remember where the card is so an interrupted slide continues from there.
      from.current = getComputedStyle(card).transform;
      animation?.cancel();
    };
  }, [open]);

  return (
    <div className={`qa-catalog-drawer ${className}`} data-open={open}>
      <div ref={cardRef} className="qa-catalog-drawer-card" inert={!open} aria-hidden={!open}>
        {children}
      </div>
      <div className="qa-catalog-drawer-front" aria-hidden="true">
        <em>{label}</em>
        <span />
      </div>
    </div>
  );
}

/** A rose bookmark ribbon that drops in from the top edge of its positioned parent. */
export function BookmarkRibbon({ show = true, length = 110, delay = 0, style, className = "" }: { show?: boolean; length?: number; delay?: number; style?: CSSProperties; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!show) return;
    const animation = animate(ref.current, [{ height: "0px" }, { height: `${length}px` }], { duration: 900, delay, easing: "cubic-bezier(.3, 1.5, .5, 1)", fill: "backwards" });
    return () => animation?.cancel();
  }, [show, length, delay]);

  if (!show) return null;
  return <span ref={ref} className={`qa-ribbon ${className}`} style={{ height: length, ...style }} aria-hidden="true" />;
}
