import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { easing, prefersReducedMotion } from "../shared/motion";

const TILES = [
  { key: "borrow", tone: "burgundy" },
  { key: "return", tone: "blush" },
  { key: "renew", tone: "wood" }
] as const;

/** Total length of the transition; "Enter now" skips it at any point. */
const DURATION_MS = 1200;

/**
 * Reader sign-in transition (~1.2 s): a closed burgundy cover opens like a binding and reveals
 * the kiosk page, then `onDone` runs (the caller redirects). Staff go straight to the console.
 * Under reduced motion the kiosk page is shown briefly without animation.
 */
export function BookOpening({ name, onDone }: { name: string; onDone: () => void }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const enterRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    enterRef.current?.focus({ preventScroll: true });
    if (prefersReducedMotion() || typeof coverRef.current?.animate !== "function") {
      const timer = window.setTimeout(() => doneRef.current(), 700);
      return () => window.clearTimeout(timer);
    }
    const tiles = Array.from(rootRef.current?.querySelectorAll(".login-open-tile") ?? []);
    const animations = [
      rootRef.current!.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" }),
      coverRef.current!.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(-118deg)" }], { duration: 750, delay: 150, easing: easing.heavy, fill: "both" }),
      ...tiles.map((tile, index) =>
        tile.animate([{ opacity: 0, transform: "scale(.4) rotate(-8deg)" }, { opacity: 1, transform: "none" }], {
          duration: 400,
          delay: 500 + index * 80,
          easing: "cubic-bezier(.2, 1.3, .4, 1)",
          fill: "backwards"
        })
      )
    ];
    const timer = window.setTimeout(() => doneRef.current(), DURATION_MS);
    return () => {
      window.clearTimeout(timer);
      animations.forEach((animation) => animation.cancel());
    };
  }, []);

  return (
    <div ref={rootRef} className="login-open" role="status" aria-live="polite">
      <div className="login-open-page">
        <p className="login-open-hello">{t("login.open.hello", { name })}</p>
        <p className="login-open-sub">{t("login.open.kiosk")}</p>
        <div className="login-open-tiles" aria-hidden="true">
          {TILES.map((tile) => (
            <span key={tile.key} className={`login-open-tile is-${tile.tone}`}>{t(`login.open.tile.${tile.key}`)}</span>
          ))}
        </div>
      </div>
      <div ref={coverRef} className="login-open-cover" aria-hidden="true">
        <b>{t("app.name")}</b>
        <span>{t("login.cover.subtitle")}</span>
      </div>
      {/* Above the cover, so it can be used from the first frame. */}
      <button ref={enterRef} type="button" className="login-open-enter" onClick={() => doneRef.current()}>
        {t("login.open.enter")}
      </button>
    </div>
  );
}
