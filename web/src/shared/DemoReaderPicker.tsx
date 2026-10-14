import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./components";
import { DEMO_MODE } from "./demoMode";

export type DemoReader = { card: string; name: string; badge: string };

/** Seeded demo readers (server/src/seed.ts, docs/DEMO_ACCOUNTS.md). The badge is a short ID, never the full card number. */
export const DEMO_READERS: DemoReader[] = [
  { card: "20240001", name: "林知秋", badge: "R-2048" },
  { card: "20240002", name: "林一诺", badge: "R-0002" },
  { card: "20240003", name: "郑云起", badge: "R-0003" },
  { card: "20240004", name: "王景行", badge: "R-0004" },
  { card: "20240005", name: "郭安宁", badge: "R-0005" },
  { card: "20240006", name: "李景行", badge: "R-0006" }
];

/**
 * "Simulate scan" in demo mode (VITE_DEMO_MODE): opens a list of the demo readers and scans the chosen card.
 * Renders nothing outside demo mode.
 */
export function DemoReaderPicker({ onPick, disabled, className }: { onPick: (card: string) => void; disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    rootRef.current?.querySelector<HTMLButtonElement>(".demo-reader-option")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!DEMO_MODE) return null;

  return (
    <div ref={rootRef} className={`demo-reader-picker${className ? ` ${className}` : ""}`}>
      <Button type="button" variant="ghost" disabled={disabled} aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        {t("login.reader.simulate")}
      </Button>
      {open ? (
        <div id={listId} className="demo-reader-popover" role="dialog" aria-label={t("demo.readers.title")}>
          <p className="demo-reader-title">{t("demo.readers.title")}</p>
          <ul>
            {DEMO_READERS.map((reader) => (
              <li key={reader.card}>
                <button
                  type="button"
                  className="demo-reader-option"
                  onClick={() => {
                    setOpen(false);
                    onPick(reader.card);
                  }}
                >
                  <span>{reader.name}</span>
                  <span className="mono">{reader.badge}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
