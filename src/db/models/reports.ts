import type { Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../connect.js";

export type ReportDecision = "approved" | "rejected";

export interface ReportDoc {
  _id: string;
  reporterId: number;
  reportedId: number;
  chatSessionId?: string;
  reason?: string;
  photoFileId?: string;
  status: "open" | "reviewed";
  decision?: ReportDecision;
  createdAt: Date;
  reviewedAt?: Date;
  reviewedBy?: number;
}

async function col(): Promise<Collection<ReportDoc>> {
  const db = await getDb();
  return db.collection<ReportDoc>("reports");
}

export async function createReport(
  reporterId: number,
  reportedId: number,
  chatSessionId: string | undefined,
  reason?: string,
  photoFileId?: string
): Promise<ReportDoc> {
  const doc: ReportDoc = {
    _id: randomUUID(),
    reporterId,
    reportedId,
    chatSessionId,
    reason,
    photoFileId,
    status: "open",
    createdAt: new Date(),
  };
  await (await col()).insertOne(doc);
  return doc;
}

export async function getReport(reportId: string): Promise<ReportDoc | null> {
  return (await col()).findOne({ _id: reportId });
}

export async function listOpenReports(limit = 20): Promise<ReportDoc[]> {
  return (await col()).find({ status: "open" }).sort({ createdAt: -1 }).limit(limit).toArray();
}

/** Atomically records the owner's approve/reject decision — only the
 *  first decision on a given report ever takes effect (returns null for
 *  a second attempt), so two admins tapping at once can't both "win" or
 *  double-pay the reward. */
export async function decideReportOnce(reportId: string, decision: ReportDecision, adminId: number): Promise<ReportDoc | null> {
  return (await col()).findOneAndUpdate(
    { _id: reportId, status: "open" },
    { $set: { status: "reviewed", decision, reviewedAt: new Date(), reviewedBy: adminId } },
    { returnDocument: "after" }
  );
}

export async function markReportReviewed(reportId: string, adminId: number): Promise<void> {
  await (await col()).updateOne({ _id: reportId }, { $set: { status: "reviewed", reviewedAt: new Date(), reviewedBy: adminId } });
}

export async function countOpenReports(): Promise<number> {
  return (await col()).countDocuments({ status: "open" });
}
