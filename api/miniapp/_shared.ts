import type { VercelRequest, VercelResponse } from "@vercel/node";

/** Mini App pages and these endpoints are served from the same origin, so
 *  no CORS is needed. Responses are never cached by shared caches. */
export function jsonHeaders(res: VercelResponse): void {
  res.setHeader("Cache-Control", "no-store");
}

export function readBody(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === "object") return b as Record<string, unknown>;
  if (typeof b === "string") {
    try {
      const parsed = JSON.parse(b);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function requirePost(req: VercelRequest, res: VercelResponse): boolean {
  jsonHeaders(res);
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return false;
  }
  return true;
}
