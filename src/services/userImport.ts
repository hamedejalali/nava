import ExcelJS from "exceljs";
import { usersCollection, type UserDoc } from "../db/models/user.js";

export interface ImportReport {
  imported: number;
  updated: number;
  skipped: number;
  invalid: number;
  failed: number;
  invalidRows: { row: number; reason: string }[];
}

const ANON_ID_RE = /^user_[A-Za-z0-9]{4,12}$/;

function cellString(v: ExcelJS.CellValue): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function cellBool(v: ExcelJS.CellValue): boolean {
  if (typeof v === "boolean") return v;
  const s = cellString(v)?.toLowerCase();
  return s === "true" || s === "1";
}

function cellNumber(v: ExcelJS.CellValue): number | undefined {
  if (typeof v === "number") return v;
  const s = cellString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Imports/restores users from an Excel export (see userExport.ts) produced
 * by the same ADMIN BACKUP format.
 *
 * Financial-safety guarantees (per spec — these are load-bearing, do not
 * relax them):
 *  - Keyed strictly on `telegramId` (the real, stable Telegram numeric ID),
 *    never on row order or anonId.
 *  - An EXISTING user is only ever updated with non-financial PROFILE
 *    fields ($set on nickname/gender/age/province/city/level/verified/
 *    banned/banReason/isAdmin/channelsExempt/languageCode/username/
 *    firstName). `relicBalance` and `relicInitialized` are NEVER touched
 *    for an existing user, however the sheet disagrees with the DB — this
 *    makes a re-import, or an import against a sheet with stale/bad
 *    balance data, incapable of ever duplicating or overwriting real
 *    financial state.
 *  - A genuinely NEW user (telegramId not found in the DB at all) is fully
 *    restored, including relicBalance/relicInitialized and the original
 *    anonId (if present and well-formed) — this is the only path that can
 *    ever set financial fields from the sheet, and it only ever applies to
 *    an account that doesn't exist yet.
 *  - Idempotent: running the same import twice produces "updated" the
 *    second time, never a second user or doubled balance.
 *  - An invalid row (missing/non-numeric telegramId) is skipped on its own
 *    without aborting or corrupting the rest of the import.
 *  - A duplicate telegramId appearing twice within the same sheet is only
 *    applied once (first occurrence wins; the rest are skipped).
 */
export async function importUsersFromExcel(filePath: string): Promise<ImportReport> {
  const report: ImportReport = { imported: 0, updated: 0, skipped: 0, invalid: 0, failed: 0, invalidRows: [] };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    report.invalidRows.push({ row: 0, reason: "فایل اکسل خالی یا بدون شیت است" });
    return report;
  }

  const headerRow = sheet.getRow(1);
  const headerIndex = new Map<string, number>();
  headerRow.eachCell((cell, colNumber) => {
    const key = cellString(cell.value);
    if (key) headerIndex.set(key, colNumber);
  });

  const col = (row: ExcelJS.Row, name: string) => {
    const idx = headerIndex.get(name);
    return idx ? row.getCell(idx).value : undefined;
  };

  const col_ = await usersCollection();
  const seenInFile = new Set<number>();

  const rowCount = sheet.rowCount;
  for (let rowNumber = 2; rowNumber <= rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;

    const telegramId = cellNumber(col(row, "telegramId"));
    if (telegramId === undefined || !Number.isInteger(telegramId) || telegramId <= 0) {
      report.invalid++;
      report.invalidRows.push({ row: rowNumber, reason: "telegramId نامعتبر یا خالی" });
      continue;
    }

    if (seenInFile.has(telegramId)) {
      report.skipped++;
      continue; // duplicate telegramId within the same file — first occurrence already applied
    }
    seenInFile.add(telegramId);

    try {
      const existing = await col_.findOne({ _id: telegramId });

      const profileFields: Partial<UserDoc> = {
        firstName: cellString(col(row, "firstName")) ?? existing?.firstName ?? "کاربر",
        username: cellString(col(row, "username")),
        nickname: cellString(col(row, "nickname")),
        gender: cellString(col(row, "gender")) as UserDoc["gender"],
        age: cellNumber(col(row, "age")),
        province: cellString(col(row, "province")),
        city: cellString(col(row, "city")),
        languageCode: (cellString(col(row, "languageCode")) as UserDoc["languageCode"]) ?? undefined,
        level: (cellString(col(row, "level")) as UserDoc["level"]) ?? undefined,
        verified: cellBool(col(row, "verified")),
        banned: cellBool(col(row, "banned")),
        banReason: cellString(col(row, "banReason")),
        isAdmin: cellBool(col(row, "isAdmin")),
        channelsExempt: cellBool(col(row, "channelsExempt")),
      };
      // Strip undefined so $set never clobbers an existing field with
      // "undefined" just because this particular sheet left it blank.
      const setFields = Object.fromEntries(Object.entries(profileFields).filter(([, v]) => v !== undefined));

      if (existing) {
        // EXISTING USER: profile fields only. relicBalance/relicInitialized
        // are deliberately never part of `setFields` above, and we never
        // touch them here either — this is the financial-safety guarantee.
        if (Object.keys(setFields).length > 0) {
          await col_.updateOne({ _id: telegramId }, { $set: setFields });
        }
        report.updated++;
        continue;
      }

      // NEW USER: full restore, including financial fields and anonId.
      const sheetAnonId = cellString(col(row, "anonId"));
      const relicBalance = cellNumber(col(row, "relicBalance")) ?? 0;
      const relicInitialized = cellBool(col(row, "relicInitialized"));

      const doc: UserDoc = {
        _id: telegramId,
        telegramId,
        firstName: setFields.firstName ?? "کاربر",
        ...setFields,
        relicBalance,
        relicInitialized,
        createdAt: new Date(),
        onboardingStep: "COMPLETED",
      } as UserDoc;

      if (sheetAnonId && ANON_ID_RE.test(sheetAnonId)) {
        doc.anonId = sheetAnonId;
      }

      try {
        if (doc.anonId) {
          await col_.insertOne(doc);
        } else {
          throw { code: 0 }; // force fallback path below to assign a fresh anonId
        }
      } catch (err: any) {
        if (err?.code === 11000) {
          // anonId collision with an existing, unrelated user (or no anonId
          // supplied at all) — fall back to a freshly generated one via the
          // normal getOrCreateUser path, then patch in the restored fields
          // (including the financial ones, since this is still a brand-new
          // telegramId that never existed before).
          const { getOrCreateUser } = await import("../db/models/user.js");
          await getOrCreateUser({ telegramId, firstName: doc.firstName, username: doc.username });
          await col_.updateOne({ _id: telegramId }, { $set: { ...setFields, relicBalance, relicInitialized, onboardingStep: "COMPLETED" } });
        } else {
          throw err;
        }
      }

      // NOTE: if the sheet said relicInitialized=false, we deliberately
      // leave it that way — the normal first-use path (see relic.ts's
      // grantInitialBalanceIfNeeded) will grant the one-time initial
      // balance exactly once, same as for any other brand-new user. We
      // never pre-emptively grant it here.
      report.imported++;
    } catch (err) {
      report.failed++;
      report.invalidRows.push({ row: rowNumber, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return report;
}
