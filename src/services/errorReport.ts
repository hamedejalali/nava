import type { Api } from "grammy";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { errInfo, logError, type ErrorCode } from "../utils/safeLog.js";
import { getLogChatId } from "./channelRouting.js";
import { escapeHtml } from "../utils/html.js";

/**
 * v1.31.0 (owner rule): every error shows a SPECIFIC log code to the person who hit it AND, at the same moment, a copy goes to the
 * log channel. The code = the stable error code (docs/ERROR_CODES.md) + a short random incident id, so one report in the channel can be
 * matched with exactly what the user/owner saw. Only privacy-safe facts are sent (class name / status, update kind, who) — never message text.
 */
export interface ErrorReport {
  code: ErrorCode;
  incident: string;
  /** what the person sees, e.g. MG-UH-001·K7F2QX */
  shown: string;
}

let windowStart = 0;
let windowCount = 0;
const MAX_COPIES_PER_MINUTE = 30; // a crash loop must not flood the channel (or Telegram's limits)

export function newIncident(code: ErrorCode): ErrorReport {
  const incident = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
  return { code, incident, shown: `${code}·${incident}` };
}

export async function sendErrorCopy(api: Api, rep: ErrorReport, info: { scope: "user" | "owner"; userId?: number; updateKind?: string; err?: unknown; description: string }): Promise<void> {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (++windowCount > MAX_COPIES_PER_MINUTE) return;
  const chat = (await getLogChatId("monitor").catch(() => undefined)) ?? env.OWNER_ID;
  if (chat === undefined) return;
  const text =
    `🚨 <b>خطا</b> <code>${escapeHtml(rep.shown)}</code>\n` +
    `سمت: ${info.scope === "owner" ? "👑 مالک/ادمین" : "👤 کاربر"}${info.userId !== undefined ? ` — <code>${info.userId}</code>` : ""}\n` +
    `نوع آپدیت: ${escapeHtml(info.updateKind ?? "—")}\n` +
    `شرح: ${escapeHtml(info.description)}\n` +
    `نوع خطا: <code>${escapeHtml(errInfo(info.err))}</code>`;
  await api.sendMessage(chat, text, { parse_mode: "HTML" }).catch(() => {});
}

export function updateKind(update: Record<string, unknown>): string {
  return Object.keys(update).find((k) => k !== "update_id") ?? "unknown";
}

/** Logs + builds the code. Call sendErrorCopy right after (or together with the reply to the person). */
export function reportUnhandled(scope: "user" | "owner", err: unknown): ErrorReport {
  const code: ErrorCode = scope === "owner" ? "MG-UH-002" : "MG-UH-001";
  const rep = newIncident(code);
  logError(code, `incident ${rep.incident}`, err);
  return rep;
}
