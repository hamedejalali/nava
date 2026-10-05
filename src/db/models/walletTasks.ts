import { randomBytes } from "node:crypto";
import { getDb } from "../connect.js";
import { env } from "../../config/env.js";
import { Api } from "grammy";
import type { UserDoc } from "./user.js";
import { WalletError, accounts, displayNameOf, getOrCreateAccount, getSettings, insertLedger, issueFromSupply, runTx } from "./walletCore.js";

export type TaskType = "channel" | "bot" | "link" | "instagram" | "other";
export interface WalletTaskDoc {
  _id: string;
  title: string;
  description: string;
  type: TaskType;
  url: string | null;
  /** chat id / @username used for automatic membership checks (type "channel") */
  chatRef: string | null;
  reward: number;
  active: boolean;
  /** mining gate: blocks further mining after `afterTaps` lifetime taps until done */
  gate: boolean;
  afterTaps: number | null;
  order: number;
  createdAt: Date;
}
export interface ClaimDoc {
  _id: string; // `${taskId}:${userId}`
  taskId: string;
  userId: number;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
  reviewedAt?: Date;
  reviewedBy?: number;
}
export interface TaskView {
  id: string; title: string; description: string; type: TaskType; url: string | null; reward: number;
  gate: boolean; afterTaps: number | null; status: "available" | "pending" | "done" | "rejected";
}

const tasksCol = async () => (await getDb()).collection<WalletTaskDoc>("wallet_tasks");
const claimsCol = async () => (await getDb()).collection<ClaimDoc>("wallet_task_claims");

export async function ensureWalletTaskIndexes() {
  await (await claimsCol()).createIndexes([{ key: { status: 1, createdAt: 1 }, name: "status_createdAt" }]);
}

// ------------------------------------------------------------ membership check (injectable for tests)
export type MembershipChecker = (chatRef: string, userId: number) => Promise<boolean>;
let checker: MembershipChecker = async (chatRef, userId) => {
  const token = env.WALLET_BOT_TOKEN;
  if (!token) throw new WalletError("server_error", 500);
  const api = new Api(token);
  const ref: string | number = /^-?\d+$/.test(chatRef) ? Number(chatRef) : chatRef;
  const m = await api.getChatMember(ref, userId);
  return ["member", "administrator", "creator"].includes(m.status);
};
export function setMembershipChecker(c: MembershipChecker | null) {
  checker = c ?? checker;
}
export type ReviewNotifier = (claim: ClaimDoc, task: WalletTaskDoc, user: UserDoc) => Promise<void>;
let notifier: ReviewNotifier = async (claim, task, user) => {
  const s = await getSettings();
  const token = env.WALLET_BOT_TOKEN;
  // Review channel if the owner set one, otherwise a direct message to the owner.
  const chat = s.taskReviewChatId ?? env.OWNER_ID;
  if (!chat || !token) return;
  const api = new Api(token);
  await api.sendMessage(
    chat,
    `📝 درخواست بررسی تسک\n\nتسک: ${task.title}\nکاربر: ${displayNameOf(user)} (${user._id})\nجایزه: ${task.reward} رلیک\nشناسه: ${claim._id}`,
    { reply_markup: { inline_keyboard: [[{ text: "✅ تایید", callback_data: `wtask:ok:${claim._id}` }, { text: "❌ رد", callback_data: `wtask:no:${claim._id}` }]] } },
  );
};
export function setReviewNotifier(n: ReviewNotifier | null) {
  if (n) notifier = n;
}

// ------------------------------------------------------------ admin CRUD
export async function createTask(input: { title: string; description?: string; type: TaskType; url?: string | null; chatRef?: string | null; reward: number; gate?: boolean; afterTaps?: number | null }) {
  if (!input.title.trim()) throw new WalletError("invalid_title");
  if (!Number.isInteger(input.reward) || input.reward < 0 || input.reward > 1_000_000) throw new WalletError("invalid_amount");
  if (input.gate && (!Number.isInteger(input.afterTaps) || (input.afterTaps as number) < 0)) throw new WalletError("invalid_taps");
  const id = randomBytes(4).toString("hex");
  const order = await (await tasksCol()).countDocuments({});
  const doc: WalletTaskDoc = {
    _id: id, title: input.title.trim().slice(0, 80), description: (input.description ?? "").trim().slice(0, 300), type: input.type,
    url: input.url?.trim() || null, chatRef: input.chatRef?.trim() || null, reward: input.reward, active: true,
    gate: !!input.gate, afterTaps: input.gate ? (input.afterTaps as number) : null, order, createdAt: new Date(),
  };
  await (await tasksCol()).insertOne(doc);
  return doc;
}
export async function listAllTasks() {
  return (await tasksCol()).find({}).sort({ order: 1 }).toArray();
}
export async function setTaskActive(id: string, active: boolean) {
  await (await tasksCol()).updateOne({ _id: id }, { $set: { active } });
}
export async function deleteTask(id: string) {
  await (await tasksCol()).deleteOne({ _id: id });
}

// ------------------------------------------------------------ user views
const isAuto = (t: WalletTaskDoc) => t.type === "channel" && !!t.chatRef;

function toView(t: WalletTaskDoc, c: ClaimDoc | undefined): TaskView {
  const status: TaskView["status"] = !c ? "available" : c.status === "approved" ? "done" : c.status === "pending" ? "pending" : "rejected";
  return { id: t._id, title: t.title, description: t.description, type: t.type, url: t.url, reward: t.reward, gate: t.gate, afterTaps: t.afterTaps, status };
}

export async function listTasksForUser(userId: number): Promise<TaskView[]> {
  const tasks = await (await tasksCol()).find({ active: true }).sort({ order: 1 }).toArray();
  const claims = await (await claimsCol()).find({ userId }).toArray();
  const byTask = new Map(claims.map((c) => [c.taskId, c]));
  return tasks.map((t) => toView(t, byTask.get(t._id)));
}

/** Mining gate: the first active gate task the user hasn't completed and whose threshold they reached. */
export async function gateFor(userId: number, tapsTotal: number): Promise<{ blocked: boolean; task: TaskView | null; allowedTaps: number }> {
  const gates = (await (await tasksCol()).find({ active: true, gate: true }).sort({ afterTaps: 1 }).toArray());
  if (!gates.length) return { blocked: false, task: null, allowedTaps: Number.POSITIVE_INFINITY };
  const claims = await (await claimsCol()).find({ userId }).toArray();
  const byTask = new Map(claims.map((c) => [c.taskId, c]));
  let allowed = Number.POSITIVE_INFINITY;
  let first: WalletTaskDoc | null = null;
  for (const g of gates) {
    if (byTask.get(g._id)?.status === "approved") continue;
    const room = Math.max(0, (g.afterTaps ?? 0) - tapsTotal);
    if (room < allowed) { allowed = room; first = g; }
  }
  const blocked = first !== null && allowed === 0;
  return { blocked, task: blocked && first ? toView(first, byTask.get(first._id)) : null, allowedTaps: allowed };
}

// ------------------------------------------------------------ claim / review
async function approveInTx(task: WalletTaskDoc, userId: number, reviewer?: number): Promise<void> {
  await runTx(async (session) => {
    const claims = await claimsCol();
    const id = `${task._id}:${userId}`;
    const res = await claims.updateOne({ _id: id, status: { $ne: "approved" } }, { $set: { status: "approved", reviewedAt: new Date(), ...(reviewer ? { reviewedBy: reviewer } : {}) } }, { session });
    if (res.matchedCount !== 1) {
      try {
        await claims.insertOne({ _id: id, taskId: task._id, userId, status: "approved", createdAt: new Date(), reviewedAt: new Date() }, { session });
      } catch (err: any) {
        if (err?.code === 11000) throw new WalletError("already_done");
        throw err;
      }
    }
    if (task.reward > 0) {
      await issueFromSupply(task.reward, session);
      await (await accounts()).updateOne({ _id: userId }, { $inc: { balance: task.reward } }, { session });
      await insertLedger({ _id: `task:${task._id}:${userId}`, kind: "task_reward", amount: task.reward, fromUser: null, toUser: userId, from: "supply", to: `wallet:${userId}`, note: task.title.slice(0, 60) }, session);
    }
  });
}

export async function claimTask(userId: number, taskId: unknown): Promise<{ status: "done" | "pending"; reward: number; newBalance: number }> {
  if (typeof taskId !== "string") throw new WalletError("task_not_found", 404);
  const task = await (await tasksCol()).findOne({ _id: taskId, active: true });
  if (!task) throw new WalletError("task_not_found", 404);
  const user = await (await getDb()).collection<UserDoc>("users").findOne({ _id: userId });
  if (!user || user.banned) throw new WalletError("banned", 403);
  await getOrCreateAccount(userId);
  const claims = await claimsCol();
  const id = `${task._id}:${userId}`;
  const existing = await claims.findOne({ _id: id });
  if (existing?.status === "approved") throw new WalletError("already_done");

  const balance = async () => (await getOrCreateAccount(userId)).balance;

  if (isAuto(task)) {
    let member = false;
    try { member = await checker(task.chatRef!, userId); } catch { throw new WalletError("server_error", 500); }
    if (!member) throw new WalletError("not_joined");
    await approveInTx(task, userId);
    return { status: "done", reward: task.reward, newBalance: await balance() };
  }

  if (existing?.status === "pending") return { status: "pending", reward: task.reward, newBalance: await balance() };
  if (existing) await claims.updateOne({ _id: id, status: "rejected" }, { $set: { status: "pending", createdAt: new Date() }, $unset: { reviewedAt: "", reviewedBy: "" } });
  else {
    try { await claims.insertOne({ _id: id, taskId: task._id, userId, status: "pending", createdAt: new Date() }); }
    catch (err: any) { if (err?.code !== 11000) throw err; }
  }
  const claim = (await claims.findOne({ _id: id }))!;
  await notifier(claim, task, user).catch((e) => console.error("[wallet] review notify failed:", e instanceof Error ? e.name : "unknown"));
  return { status: "pending", reward: task.reward, newBalance: await balance() };
}

/** Owner decision from the review channel. Idempotent: only a pending claim can be decided. */
export async function reviewClaim(claimId: string, approve: boolean, reviewer: number): Promise<"approved" | "rejected" | "already" | "not_found" | "supply_exhausted"> {
  const claims = await claimsCol();
  const claim = await claims.findOne({ _id: claimId });
  if (!claim) return "not_found";
  if (claim.status !== "pending") return "already";
  const task = await (await tasksCol()).findOne({ _id: claim.taskId });
  if (!task) return "not_found";
  if (!approve) {
    const r = await claims.updateOne({ _id: claimId, status: "pending" }, { $set: { status: "rejected", reviewedAt: new Date(), reviewedBy: reviewer } });
    return r.matchedCount === 1 ? "rejected" : "already";
  }
  try {
    await approveInTx(task, claim.userId, reviewer);
    return "approved";
  } catch (err) {
    if (err instanceof WalletError && err.code === "supply_exhausted") return "supply_exhausted";
    if (err instanceof WalletError && err.code === "already_done") return "already";
    throw err;
  }
}
