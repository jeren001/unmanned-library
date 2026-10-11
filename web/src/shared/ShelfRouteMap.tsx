import { useId } from "react";
import { useTranslation } from "react-i18next";
import { usePrefersReducedMotion } from "./motion";

/*
 * Floor plan with eight shelf zones (A–H, two rows of four). Each zone has five bays;
 * shelf numbers 1–40 map onto them. The route runs from the kiosk along the aisles to
 * the front of the target bay. Shelf locations look like "EAST-C-17" or "A-3-2".
 */

export type ShelfPosition = { zone: string; zoneIndex: number; shelf: number; bay: number };

const ZONES = 8;
const BAYS = 5;
const SHELF = { width: 64, height: 26, firstX: 28, gapX: 80, rows: [28, 104] } as const;
const KIOSK = { x: 24, y: 214 } as const;
const MAIN_AISLE_Y = 170;
const MIDDLE_AISLE_Y = 79;
const SIDE_AISLES = [14, 100, 180, 260, 342];

export function parseShelfLocation(location: string | undefined | null): ShelfPosition | null {
  if (!location) return null;
  const parts = location.toUpperCase().split(/[-\s/·_]+/).filter(Boolean);
  const zone = [...parts].reverse().find((part) => /^[A-H]$/.test(part));
  if (!zone) return null;
  const numbers = parts.filter((part) => /^\d+$/.test(part)).map(Number);
  const shelf = Math.max(1, numbers[numbers.length - 1] ?? 1);
  return { zone, zoneIndex: zone.charCodeAt(0) - 65, shelf, bay: Math.min(BAYS - 1, Math.floor(((shelf - 1) % 40) / 8)) };
}

function zoneBox(index: number) {
  return { x: SHELF.firstX + (index % 4) * SHELF.gapX, y: SHELF.rows[Math.floor(index / 4)] };
}

/** SVG path data for the walk from the kiosk to the front of the target bay. */
export function shelfRoute(position: ShelfPosition) {
  const box = zoneBox(position.zoneIndex);
  const bayWidth = SHELF.width / BAYS;
  const x = Math.round((box.x + (position.bay + 0.5) * bayWidth) * 10) / 10;
  const start = `M${KIOSK.x} ${KIOSK.y} L${KIOSK.x} ${MAIN_AISLE_Y}`;
  if (position.zoneIndex >= 4) return `${start} L${x} ${MAIN_AISLE_Y} L${x} ${box.y + SHELF.height + 6}`;
  const aisle = SIDE_AISLES.reduce((best, candidate) => (Math.abs(candidate - x) < Math.abs(best - x) ? candidate : best));
  return `${start} L${aisle} ${MAIN_AISLE_Y} L${aisle} ${MIDDLE_AISLE_Y} L${x} ${MIDDLE_AISLE_Y} L${x} ${box.y + SHELF.height + 6}`;
}

export function ShelfRouteMap({ location, className = "" }: { location: string | undefined | null; className?: string }) {
  const { t } = useTranslation();
  const reduced = usePrefersReducedMotion();
  const routeId = `route-${useId().replace(/:/g, "")}`;
  const target = parseShelfLocation(location);
  const label = target
    ? t("shelfMap.label", { location, zone: target.zone, shelf: target.shelf })
    : t("shelfMap.unknown", { location: location ?? "—" });

  return (
    <svg className={`qa-shelf-map ${className}`} viewBox="0 0 356 232" role="img" aria-label={label}>
      <rect className="qa-shelf-floor" x="2" y="2" width="352" height="228" rx="12" />
      {Array.from({ length: ZONES }, (_, index) => {
        const box = zoneBox(index);
        const zone = String.fromCharCode(65 + index);
        return (
          <g key={zone}>
            <rect className="qa-shelf-block" x={box.x} y={box.y} width={SHELF.width} height={SHELF.height} rx="3" />
            <text className="qa-shelf-zone" x={box.x + 6} y={box.y + 17}>{zone}</text>
          </g>
        );
      })}
      {target ? (
        <>
          <rect
            className="qa-shelf-target"
            x={zoneBox(target.zoneIndex).x + target.bay * (SHELF.width / BAYS)}
            y={zoneBox(target.zoneIndex).y}
            width={SHELF.width / BAYS}
            height={SHELF.height}
            rx="2"
          />
          <text className="qa-shelf-callout" x={zoneBox(target.zoneIndex).x + SHELF.width / 2} y={zoneBox(target.zoneIndex).y - 7} textAnchor="middle">
            {location}
          </text>
          <path id={routeId} className="qa-shelf-route" d={shelfRoute(target)} />
          {reduced ? null : (
            <circle className="qa-shelf-walker" r="6">
              <animateMotion dur="3s" repeatCount="indefinite" rotate="auto">
                <mpath href={`#${routeId}`} />
              </animateMotion>
            </circle>
          )}
        </>
      ) : null}
      <circle className="qa-shelf-kiosk" cx={KIOSK.x} cy={KIOSK.y} r="9" />
      <text className="qa-shelf-here" x={KIOSK.x + 16} y={KIOSK.y + 4}>{t("shelfMap.youAreHere")}</text>
    </svg>
  );
}
