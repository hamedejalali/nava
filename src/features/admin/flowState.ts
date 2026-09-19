import { getDb } from "../../db/connect.js";

export interface AdminFlowState {
  flow: string;
  stage: string;
  data?: Record<string, unknown>;
}

async function col() {
  const db = await getDb();
  return db.collection<AdminFlowState & { _id: number }>("admin_flow_state");
}

export async function setAdminFlow(adminId: number, state: AdminFlowState | null): Promise<void> {
  const c = await col();
  if (!state) {
    await c.deleteOne({ _id: adminId });
  } else {
    await c.updateOne({ _id: adminId }, { $set: state }, { upsert: true });
  }
}

export async function getAdminFlow(adminId: number): Promise<(AdminFlowState & { _id: number }) | null> {
  const c = await col();
  return c.findOne({ _id: adminId });
}

/**
 * Every "awaiting a text reply" admin flow in this codebase (search
 * queries, ban/unban targets, broadcast text, level assignment, bio/
 * province/city edits, etc.) used to unconditionally treat WHATEVER text
 * arrived next as the answer — including "/start" itself. That meant a
 * stuck or unwanted flow could swallow every subsequent message forever,
 * with no way to back out (exactly the "لغو نمیشه" bug report). Every one
 * of those handlers now calls this first: if the admin sent a command
 * (anything starting with "/") or a plain-language cancel word, the flow
 * is abandoned and the message is passed through to `next()` so slash
 * commands keep working normally.
 */
export function isFlowCancelSignal(text: string): boolean {
  const t = text.trim();
  return t.startsWith("/") || ["لغو", "کنسل", "انصراف", "بازگشت", "لغو کن"].includes(t);
}
