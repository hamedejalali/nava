import ExcelJS from "exceljs";
import { getDb } from "../db/connect.js";
import type { UserDoc } from "../db/models/user.js";

/**
 * Columns included in the admin Excel export. Deliberately limited to
 * profile + wallet-relevant fields: NEVER secrets, chat content, photos, or
 * precise GPS location (per the feature requirement — "never secrets, chat
 * content, or photos"). `telegramId` + `anonId` are the two identifiers
 * userImport.ts keys a restore on.
 */
const COLUMNS: { header: string; key: string; width?: number }[] = [
  { header: "telegramId", key: "telegramId", width: 16 },
  { header: "anonId", key: "anonId", width: 14 },
  { header: "firstName", key: "firstName", width: 18 },
  { header: "username", key: "username", width: 16 },
  { header: "nickname", key: "nickname", width: 16 },
  { header: "gender", key: "gender", width: 10 },
  { header: "age", key: "age", width: 6 },
  { header: "province", key: "province", width: 14 },
  { header: "city", key: "city", width: 14 },
  { header: "languageCode", key: "languageCode", width: 10 },
  { header: "level", key: "level", width: 12 },
  { header: "verified", key: "verified", width: 10 },
  { header: "banned", key: "banned", width: 10 },
  { header: "banReason", key: "banReason", width: 20 },
  { header: "isAdmin", key: "isAdmin", width: 10 },
  { header: "relicBalance", key: "relicBalance", width: 14 },
  { header: "relicInitialized", key: "relicInitialized", width: 16 },
  { header: "referredBy", key: "referredBy", width: 14 },
  { header: "channelsExempt", key: "channelsExempt", width: 14 },
  { header: "onboardingStep", key: "onboardingStep", width: 16 },
];

/**
 * Streams every user document into an .xlsx file at `filePath` using
 * ExcelJS's streaming WorkbookWriter — memory-safe for large user counts
 * (never buffers the whole workbook, or the whole user collection, in
 * memory at once). Returns the number of rows written.
 */
export async function exportUsersToExcel(filePath: string): Promise<number> {
  const db = await getDb();
  const cursor = db.collection<UserDoc>("users").find({}, { projection: Object.fromEntries(COLUMNS.map((c) => [c.key, 1])) });

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: filePath, useStyles: false, useSharedStrings: false });
  const sheet = workbook.addWorksheet("users");
  sheet.columns = COLUMNS;

  let count = 0;
  for await (const doc of cursor) {
    sheet.addRow({
      telegramId: doc.telegramId ?? doc._id,
      anonId: doc.anonId,
      firstName: doc.firstName,
      username: doc.username ?? "",
      nickname: doc.nickname ?? "",
      gender: doc.gender ?? "",
      age: doc.age ?? "",
      province: doc.province ?? "",
      city: doc.city ?? "",
      languageCode: doc.languageCode ?? "",
      level: doc.level ?? "",
      verified: !!doc.verified,
      banned: !!doc.banned,
      banReason: doc.banReason ?? "",
      isAdmin: !!doc.isAdmin,
      relicBalance: doc.relicBalance ?? 0,
      relicInitialized: !!doc.relicInitialized,
      referredBy: doc.referredBy ?? "",
      channelsExempt: !!doc.channelsExempt,
      onboardingStep: (doc as any).onboardingStep ?? "",
    }).commit();
    count++;
  }

  sheet.commit();
  await workbook.commit();
  return count;
}
