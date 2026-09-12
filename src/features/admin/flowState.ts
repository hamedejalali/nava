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
