import type { Collection } from "mongodb";
import { getDb } from "../connect.js";

export interface AdminLogEntry {
  _id?: any;
  adminId: number;
  action: string;
  details?: string;
  createdAt: Date;
}

async function col(): Promise<Collection<AdminLogEntry>> {
  const db = await getDb();
  return db.collection<AdminLogEntry>("admin_activity_log");
}

export async function logAdminAction(adminId: number, action: string, details?: string): Promise<void> {
  await (await col()).insertOne({ adminId, action, details, createdAt: new Date() });
}

export async function getRecentAdminLogs(limit = 20): Promise<AdminLogEntry[]> {
  return (await col()).find({}).sort({ createdAt: -1 }).limit(limit).toArray();
}
