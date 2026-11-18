/**
 * Builds src/generated/textCatalog.ts — every user-facing text and button label found in the source (static analysis, TypeScript AST).
 * The owner's «ویرایش متن‌ها / دکمه‌ها» works on this list: an edited entry replaces that literal wherever the bot sends it.
 * Run: npm run gen:texts   (the result is committed; tests/regression/v1320 checks that it is not stale).
 */
import ts from "typescript";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const FA = /[؀-ۿ]/;
const SKIP_DIRS = ["src/generated", "src/db", "src/utils", "src/webhook", "src/data"];
const SKIP_FILES_RE = /(\.test\.ts$|\/emojis\.ts$|\/defaultTexts\.ts$)/;
const NO_TEXT_CALLS = new Set(["includes", "startsWith", "endsWith", "test", "RegExp", "logError", "logWarn", "logInfo", "log", "warn", "error", "info", "debug", "logAdminAction", "Error", "assert", "equal", "match", "indexOf", "replace", "replaceAll", "split", "on", "hears", "command", "callbackQuery", "get", "has", "set", "add", "delete", "setAppVar", "getAppVar", "setAdminFlow", "setUserFlow", "newIncident", "logActivity"]);
const BUTTON_CALLS = new Set(["glassButton", "glassReplyButton", "button", "replyButton", "urlButton", "webAppButton"]);

const CATS: Array<[RegExp, string]> = [
  [/locales\/en\.ts$/, "🇬🇧 متن‌های English"],
  [/locales\/ar\.ts$/, "🇸🇦 متن‌های العربية"],
  [/(channelRouting|errorReport|broadcastProcessor|monitorOps|services\/monitor\.ts|adminAudit|nava\/safety|giftEvents)/i, "📜 دسته تکست‌های لاگ"],
  [/onboarding/, "🚀 ثبت‌نام و شروع"],
  [/features\/menu\/(profile|myProfile)|matching\/profile|features\/photo/, "👤 پروفایل"],
  [/features\/matching/, "💬 چت ناشناس"],
  [/anonMessages|inbox|feedback/, "📨 پیام ناشناس و پیشنهاد"],
  [/features\/menu/, "🏠 منوی اصلی"],
  [/features\/games|services\/games/, "🎲 بازی‌ها"],
  [/features\/shop|payments|wallet|relic|jeton/i, "🛒 خرید، ولت و ژتون"],
  [/forcejoin/, "📢 عضویت اجباری"],
  [/support/, "🛟 پشتیبانی و قوانین"],
  [/gifts/, "🎁 هدیه‌ها"],
  [/search/, "🔎 جستجو"],
  [/reactionGate/, "💌 دروازه‌ی واکنش"],
  [/services\/nava|miniapp|api\//, "🌙 مویاگرام و مینی‌اپ"],
  [/locales\/fa\.ts$/, "📚 متن‌های ثابت ربات"],
  [/.*/, "📦 سایر متن‌ها"],
];
const catOf = (file: string) => CATS.find(([re]) => re.test(file))![1];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const rel = relative(ROOT, p).replace(/\\/g, "/");
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.some((d) => rel === d || rel.startsWith(d + "/"))) walk(p, out);
    } else if (p.endsWith(".ts") && !SKIP_FILES_RE.test(rel)) out.push(rel);
  }
  return out;
}

interface Entry {
  id: string;
  kind: "text" | "button";
  cat: string;
  files: string[];
  parts: string[];
  vars: string[];
}
const entries = new Map<string, Entry>();

function varName(e: ts.Expression, i: number, used: Set<string>): string {
  let n = "";
  if (ts.isIdentifier(e)) n = e.text;
  else if (ts.isPropertyAccessExpression(e)) n = e.name.text;
  else if (ts.isNonNullExpression(e) && ts.isPropertyAccessExpression(e.expression)) n = e.expression.name.text;
  if (!n || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) n = `v${i + 1}`;
  let u = n;
  for (let k = 2; used.has(u); k++) u = `${n}${k}`;
  used.add(u);
  return u;
}

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return "";
}

function excluded(node: ts.Node): boolean {
  for (let p: ts.Node | undefined = node.parent, depth = 0; p && depth < 6; p = p.parent, depth++) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isCaseClause(p) || ts.isTypeNode(p) || ts.isLiteralTypeNode(p) || ts.isThrowStatement(p) || ts.isTaggedTemplateExpression(p)) return true;
    if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(p.operatorToken.kind)) return true;
    if (ts.isCallExpression(p) && NO_TEXT_CALLS.has(calleeName(p))) return true;
    if (ts.isNewExpression(p)) return true;
    if (ts.isPropertyAssignment(p) && p.name === node) return true;
  }
  return false;
}

function isButton(node: ts.Node, file: string, keyPath: string): boolean {
  const p = node.parent;
  if (p && ts.isCallExpression(p) && BUTTON_CALLS.has(calleeName(p)) && p.arguments[0] === node) return true;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "text" && p.parent?.parent && (ts.isArrayLiteralExpression(p.parent.parent) || ts.isCallExpression(p.parent.parent))) {
    // `{ text: "..." }` inside keyboard arrays only
    const gp = p.parent.parent;
    if (ts.isArrayLiteralExpression(gp)) return true;
  }
  if (/locales\//.test(file) && /(^|\.)(mainMenu\.|[A-Za-z]*Button[A-Za-z]*$|button)/i.test(keyPath)) return true;
  return false;
}

function pathOf(node: ts.Node): string {
  const keys: string[] = [];
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.unshift(p.name.text);
  }
  return keys.join(".");
}

function add(file: string, kind: "text" | "button", parts: string[], vars: string[]) {
  const staticText = parts.join("");
  const letters = (staticText.match(/[\p{L}]/gu) ?? []).length;
  const isLocale = /locales\/(en|ar)\.ts$/.test(file);
  if (staticText.trim().length < 3 || (!isLocale && !FA.test(staticText)) || letters < 2) return;
  if (/^[\s\p{P}\p{S}]*$/u.test(staticText)) return;
  const key = kind + "\u0000" + parts.join("\u0001") + "\u0002" + file.match(/locales\/(en|ar)\./)?.[1];
  const id = (kind === "text" ? "t" : "b") + createHash("sha1").update(key).digest("hex").slice(0, 8);
  const ex = entries.get(id);
  if (ex) {
    if (!ex.files.includes(file)) ex.files.push(file);
    return;
  }
  entries.set(id, { id, kind, cat: catOf(file), files: [file], parts, vars });
}

for (const file of walk(join(ROOT, "src")).filter((f) => !f.startsWith("src/features/admin/") || /admin\/guides\.ts$/.test(f))) {
  const src = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.ES2022, true);
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !excluded(node)) {
      add(file, isButton(node, file, pathOf(node)) ? "button" : "text", [node.text], []);
    } else if (ts.isTemplateExpression(node) && !excluded(node)) {
      const parts = [node.head.text];
      const vars: string[] = [];
      const used = new Set<string>();
      node.templateSpans.forEach((sp, i) => {
        vars.push(varName(sp.expression, i, used));
        parts.push(sp.literal.text);
      });
      add(file, isButton(node, file, pathOf(node)) ? "button" : "text", parts, vars);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

const list = [...entries.values()].sort((a, b) => a.cat.localeCompare(b.cat, "fa") || a.id.localeCompare(b.id));
const body = `// AUTO-GENERATED by scripts/gen-text-catalog.ts — do not edit by hand. Regenerate with: npm run gen:texts
export interface CatalogEntry { id: string; kind: "text" | "button"; cat: string; files: string[]; parts: string[]; vars: string[] }
export const CATALOG: CatalogEntry[] = ${JSON.stringify(list, null, 0).replace(/\},\{/g, "},\n{")};
`;
writeFileSync(join(ROOT, "src/generated/textCatalog.ts"), body);
const byCat: Record<string, number> = {};
for (const e of list) byCat[e.cat] = (byCat[e.cat] ?? 0) + 1;
console.log(list.length, "entries", byCat);
