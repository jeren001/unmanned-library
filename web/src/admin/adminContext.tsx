import { createContext, useContext, useEffect, useRef } from "react";
import type { Branch, SessionUser } from "./adminApi";

/* Shared admin state: the signed-in user, the branch list, and a hub that re-broadcasts the shell's SSE stream. */

export type AdminEventName = "alert.raised" | "alert.acked" | "alert.resolved" | "device.status_changed" | "kpi.updated";

export class AdminEventHub {
  private target = new EventTarget();

  emit(name: AdminEventName, payload: unknown) {
    this.target.dispatchEvent(new CustomEvent(name, { detail: payload }));
  }

  on(name: AdminEventName, listener: (payload: unknown) => void) {
    const wrapped = (event: Event) => listener((event as CustomEvent).detail);
    this.target.addEventListener(name, wrapped);
    return () => this.target.removeEventListener(name, wrapped);
  }
}

export type AdminContextValue = { user: SessionUser; branches: Branch[]; branchId: string; branchName: (id: string) => string; events: AdminEventHub };

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin() {
  const value = useContext(AdminContext);
  if (!value) throw new Error("useAdmin must be used inside the admin shell");
  return value;
}

/** Subscribes to live admin events; the handler may change between renders. */
export function useAdminEvent<P = Record<string, unknown>>(names: AdminEventName[], handler: (payload: P, name: AdminEventName) => void) {
  const { events } = useAdmin();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = names.join(",");
  useEffect(() => {
    const offs = key.split(",").map((name) => events.on(name as AdminEventName, (payload) => handlerRef.current(payload as P, name as AdminEventName)));
    return () => offs.forEach((off) => off());
  }, [events, key]);
}
