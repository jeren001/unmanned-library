import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { animate, easing } from "../shared/motion";

export type Command = { id: string; label: string; hint?: string; group: string; run: () => void };

/** Ctrl/⌘+K palette: filter, arrow keys to move, Enter to run, Escape to close. */
export function CommandPalette({ open, onClose, commands, searchCommand }: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** Extra command built from the typed text, e.g. "search books for …". */
  searchCommand?: (text: string) => Command | null;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const listId = useId();

  const needle = text.trim().toLowerCase();
  const matches = commands.filter((command) => !needle || `${command.label} ${command.hint ?? ""}`.toLowerCase().includes(needle));
  const extra = needle && searchCommand ? searchCommand(text.trim()) : null;
  const items = extra ? [...matches, extra] : matches;

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setText("");
    setActive(0);
    inputRef.current?.focus();
    return () => returnFocus.current?.focus?.();
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const animation = animate(panelRef.current, [{ opacity: 0, transform: "translateY(-12px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: easing.out });
    return () => animation?.cancel();
  }, [open]);

  useEffect(() => setActive(0), [text]);

  if (!open) return null;

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(items.length - 1, value + 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
    if (event.key === "Enter") { event.preventDefault(); run(items[active]); }
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") event.preventDefault();
  };

  let lastGroup = "";
  return (
    <div className="admin-palette-backdrop" onMouseDown={onClose}>
      <div ref={panelRef} className="admin-palette" role="dialog" aria-modal="true" aria-label={t("admin.palette.title")} onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="admin-palette-input">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="6" /><path d="M14 14l4 4" /></svg>
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("admin.palette.placeholder")}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[active] ? `${listId}-${items[active].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id={listId} role="listbox" className="admin-palette-list">
          {items.length ? items.map((command, index) => {
            const header = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <li key={command.id} role="presentation">
                {header ? <p className="admin-palette-group" aria-hidden="true">{header}</p> : null}
                <div
                  id={`${listId}-${command.id}`}
                  role="option"
                  aria-selected={index === active}
                  className="admin-palette-item"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(command)}
                >
                  <span>{command.label}</span>
                  {command.hint ? <small className="mono">{command.hint}</small> : null}
                </div>
              </li>
            );
          }) : <li className="admin-palette-empty">{t("admin.palette.noResults")}</li>}
        </ul>
        <p className="admin-palette-foot"><kbd>↑</kbd><kbd>↓</kbd> {t("admin.palette.move")} · <kbd>Enter</kbd> {t("admin.palette.run")}</p>
      </div>
    </div>
  );
}
