import { InputFile, type Composer } from "grammy";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitUntil } from "@vercel/functions";
import type { NavaContext } from "../../bot-context.js";
import { isOwner } from "./constants.js";
import { ADMIN_MENU_LABELS } from "./menu.js";
import { setAdminFlow, getAdminFlow, isFlowCancelSignal } from "./flowState.js";
import { cancelKeyboard } from "../common/userFlows.js";
import { exportUsersToExcel } from "../../services/userExport.js";
import { importUsersFromExcel, type ImportReport } from "../../services/userImport.js";
import { acquireExportLock, releaseExportLock } from "../../db/models/exportJobLock.js";
import { env } from "../../config/env.js";

/**
 * Admin-only (OWNER-ONLY — see menu.ts's OWNER_ONLY list) Excel
 * export/import of user data.
 *
 * Export: streams the users collection to a temp .xlsx (see
 * userExport.ts), DMs it to the requesting admin, and — if
 * BACKUP_CHANNEL_ID is configured — also sends a copy there. Guarded by a
 * MongoDB-based lock (exportJobLock.ts) so a double-tap or two admins
 * triggering it seconds apart can never run two overlapping streaming
 * exports. The actual export runs inside `waitUntil` so the webhook
 * response returns immediately (same "don't block the webhook" principle
 * as the search-countdown fix) while the file is prepared and sent in the
 * background on the same warm invocation.
 *
 * Import: two-step flow — tap the button, then upload the .xlsx file —
 * using the standard admin_flow_state machine. The parse + DB writes run
 * through importUsersFromExcel (see that file for the financial-safety
 * guarantees: existing users' relicBalance/relicInitialized are NEVER
 * touched, only brand-new telegramIds get financial fields restored), and
 * also runs inside `waitUntil` since a large file can take longer than is
 * comfortable to hold the webhook open for.
 */
export function registerUserBackup(composer: Composer<NavaContext>) {
  composer.on("message:text", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const text = ctx.message.text.trim();

    if (text === ADMIN_MENU_LABELS.exportUsers) {
      const adminId = ctx.from!.id;
      const locked = await acquireExportLock(adminId);
      if (!locked) {
        await ctx.reply("⏳ یک خروجی اکسل دیگه در حال اجراست، چند دقیقه صبر کن و دوباره امتحان کن.");
        return;
      }

      await ctx.reply("⏳ در حال تهیه خروجی اکسل کاربران... به محض آماده شدن برات ارسال می‌شه.");
      waitUntil(runExport(ctx, adminId));
      return;
    }

    if (text === ADMIN_MENU_LABELS.importUsers) {
      await setAdminFlow(ctx.from!.id, { flow: "import_users", stage: "await_file" });
      await ctx.reply(
        "فایل اکسل خروجی (همون فرمت «خروجی اکسل کاربران») رو برای بازیابی ارسال کن.\n" +
          "⚠️ این عملیات موجودی رلیک کاربرای موجود رو دست نمی‌زنه، فقط کاربرای جدید که توی دیتابیس نیستن کامل بازیابی می‌شن.",
        { reply_markup: cancelKeyboard() }
      );
      return;
    }

    const flow = await getAdminFlow(ctx.from!.id);
    if (flow?.flow === "import_users" && flow.stage === "await_file" && isFlowCancelSignal(text)) {
      await setAdminFlow(ctx.from!.id, null);
      if (text.startsWith("/")) return next();
      await ctx.reply("لغو شد.");
      return;
    }

    return next();
  });

  composer.on("message:document", async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    const flow = await getAdminFlow(ctx.from!.id);
    if (!flow || flow.flow !== "import_users" || flow.stage !== "await_file") return next();

    const doc = ctx.message.document;
    const fileName = doc.file_name ?? "";
    if (!fileName.toLowerCase().endsWith(".xlsx")) {
      await ctx.reply("فایل باید فرمت .xlsx داشته باشه. دوباره ارسال کن یا «لغو» رو بفرست.");
      return;
    }

    await setAdminFlow(ctx.from!.id, null);
    await ctx.reply("⏳ در حال پردازش فایل و بازیابی کاربران... نتیجه به محض اتمام ارسال می‌شه.");
    waitUntil(runImport(ctx, doc.file_id));
  });
}

async function runExport(ctx: NavaContext, adminId: number): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "nava-export-"));
  const file = path.join(dir, `nava-users-${new Date().toISOString().slice(0, 10)}.xlsx`);
  try {
    const count = await exportUsersToExcel(file);
    const caption = `📤 خروجی اکسل کاربران — ${count} کاربر`;

    await ctx.api.sendDocument(adminId, new InputFile(file, path.basename(file)), { caption }).catch((err) => {
      console.error("[userBackup] failed to DM export to admin:", err);
    });

    if (env.BACKUP_CHANNEL_ID !== undefined) {
      await ctx.api.sendDocument(env.BACKUP_CHANNEL_ID, new InputFile(file, path.basename(file)), { caption }).catch((err) => {
        console.error("[userBackup] failed to send export to backup channel:", err);
      });
    }
  } catch (err) {
    console.error("[userBackup] export failed:", err);
    await ctx.api.sendMessage(adminId, "❌ خروجی اکسل با خطا مواجه شد. لاگ سرور رو بررسی کن.").catch(() => {});
  } finally {
    await releaseExportLock();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runImport(ctx: NavaContext, fileId: string): Promise<void> {
  const adminId = ctx.from!.id;
  const dir = await mkdtemp(path.join(tmpdir(), "nava-import-"));
  const file = path.join(dir, "import.xlsx");
  try {
    const tgFile = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${tgFile.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`دانلود فایل از تلگرام ناموفق بود (status ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    await (await import("node:fs/promises")).writeFile(file, buf);

    const report: ImportReport = await importUsersFromExcel(file);
    await ctx.api.sendMessage(adminId, formatImportReport(report));
  } catch (err) {
    console.error("[userBackup] import failed:", err);
    await ctx.api
      .sendMessage(adminId, `❌ بازیابی با خطا مواجه شد: ${err instanceof Error ? err.message : String(err)}`)
      .catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatImportReport(report: ImportReport): string {
  const lines = [
    "✅ بازیابی از اکسل تمام شد:",
    `🆕 کاربر جدید بازیابی شد: ${report.imported}`,
    `♻️ کاربر موجود به‌روزرسانی شد: ${report.updated}`,
    `⏭ ردیف تکراری نادیده گرفته شد: ${report.skipped}`,
    `⚠️ ردیف نامعتبر: ${report.invalid}`,
    `❌ خطا در پردازش: ${report.failed}`,
  ];

  if (report.invalidRows.length > 0) {
    lines.push("", "نمونه ردیف‌های مشکل‌دار:");
    for (const r of report.invalidRows.slice(0, 10)) {
      lines.push(`ردیف ${r.row}: ${r.reason}`);
    }
    if (report.invalidRows.length > 10) {
      lines.push(`... و ${report.invalidRows.length - 10} مورد دیگر`);
    }
  }

  return lines.join("\n");
}
