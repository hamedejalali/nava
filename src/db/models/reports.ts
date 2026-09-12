import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export interface ReportDoc {
  _id: string;
  reporterId: number;
  reportedId: number;
  chatSessionId?: string;
  status: "open" | "reviewed";
  createdAt: Date;
  reviewedAt?: Date;
  reviewedBy?: number;
}

async function col(): Promise<Collection<ReportDoc>> {
  const db = await getDb();
  return db.collection<ReportDoc>("reports");
}

export async function createReport(reporterId: number, reportedId: number, chatSessionId?: string): Promise<ReportDoc> {
  const doc: ReportDoc = { _id: randomUUID(), reporterId, reportedId, chatSessionId, status: "open", createdAt: new Date() };
  await (await col()).insertOne(doc);
  return doc;
}

export async function listOpenReports(limit = 20): Promise<ReportDoc[]> {
  return (await col()).find({ status: "open" }).sort({ createdAt: -1 }).limit(limit).toArray();
}

export async function markReportReviewed(reportId: string, adminId: number): Promise<void> {
  await (await col()).updateOne({ _id: reportId }, { $set: { status: "reviewed", reviewedAt: new Date(), reviewedBy: adminId } });
}

export async function countOpenReports(): Promise<number> {
  return (await col()).countDocuments({ status: "open" });
}
