/**
 * Session handling for the TanStack Start server functions.
 *
 * The browser holds an HttpOnly cookie (`guardian_sid`) naming the stored
 * record. A request middleware reads it into the request context; server fns
 * use `getSessionRecord()` to find the caller's record, and `setSessionCookie`
 * to issue/clear the cookie on the response.
 */
import { createMiddleware } from "@tanstack/react-start";
import type { GuardianRecord } from "@guardian/server/store.js";

export const COOKIE = "guardian_sid";

export function readSid(request: Request): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE && v) return v;
  }
  return null;
}

export function sessionCookieHeader(id: string, clear = false): string {
  const maxAge = clear ? 0 : 12 * 60 * 60; // 12h cookie; the record persists in the store.
  return `${COOKIE}=${clear ? "" : id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** Request middleware: attach the sid (record id) + client IP to the context. */
export const sessionMiddleware = createMiddleware({
  type: "request",
}).server(async ({ request, next }) => {
  const result = await next({
    context: {
      sid: readSid(request),
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        ?? request.headers.get("x-real-ip")
        ?? "unknown",
    },
  });
  return result;
});

/** Resolve the caller's stored record from the sid in context, or null. */
export async function getSessionRecord(sid: string | null | undefined): Promise<GuardianRecord | null> {
  if (!sid) return null;
  const { getContext } = await import("./bootstrap.server.js");
  const { store } = getContext();
  return store.getById(sid);
}
