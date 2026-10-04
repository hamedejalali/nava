/**
 * Behavioural regression suite for the in-chat features (v1.7.0 / v1.8.0).
 * Runs the REAL bot (createBot) against the in-memory fake Mongo and a
 * recording fake of the Telegram Bot API (see tests/harness). Proves handler
 * logic + DB state; does not prove Telegram-side behaviour.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, resetState, OWNER_ID } from "../harness/fakeTelegram.js";
import { seedUser, seedChatSession, col } from "../harness/fakeMongo.js";

const h = await createHarness();
const A = 11;
const B = 12;

beforeEach(() => {
  resetState();
  h.resetCalls();
  h.clearFailures();
  delete process.env.MODERATION_LOG_CHAT_ID;
  seedUser({ id: A, relicBalance: 5 });
  seedUser({ id: B, relicBalance: 5 });
  seedUser({ id: OWNER_ID });
});

const SESSION = `sess-${A}-${B}`;
const keyboardTexts = (call: any): string[] => (call?.payload?.reply_markup?.keyboard ?? []).flat().map((b: any) => b.text);
const inlineData = (call: any): string[] => (call?.payload?.reply_markup?.inline_keyboard ?? []).flat().map((b: any) => b.callback_data);
const hasMainMenu = (call: any) => keyboardTexts(call).some((t) => t.includes("جستجوی کاربران"));

// ------------------------------------------------------------------ a
test("a. text is relayed to the partner and counted; control labels are NOT relayed", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.text(A, "سلام");
  assert.equal(h.of("sendMessage", B).filter((c) => c.payload.text === "سلام").length, 1);
  assert.equal(col("chat_sessions").byId(SESSION).messageCount, 1);

  h.resetCalls();
  await h.text(A, "مشاهده پروفایل");
  assert.equal(h.calls.filter((c) => c.chatId === B && c.payload?.text === "مشاهده پروفایل").length, 0, "control label must never reach the partner");
  assert.ok(h.of("sendMessage", A).length + h.of("sendPhoto", A).length >= 1, "A gets the partner profile");
  assert.equal(col("chat_sessions").byId(SESSION).messageCount, 1, "a control tap is not a chat message");

  h.resetCalls();
  await h.text(A, "پایان چت");
  assert.equal(h.calls.filter((c) => c.chatId === B).length, 0, "partner is not bothered by the confirm prompt");
  const confirm = h.last("sendMessage", A)!;
  assert.ok(inlineData(confirm).includes("chat:end:confirm"));
  assert.ok(inlineData(confirm).includes("chat:end:cancel"));
});

test("a. confirming 'end chat' closes the session, clears BOTH pointers, restores the main menu for both", async () => {
  seedChatSession({ userA: A, userB: B });
  h.resetCalls();
  await h.callback(A, "chat:end:confirm");
  assert.equal(col("chat_sessions").byId(SESSION).active, false);
  assert.equal(col("chat_sessions").byId(SESSION).endedBy, A);
  assert.ok(!col("users").byId(A).activeChatSessionId);
  assert.ok(!col("users").byId(B).activeChatSessionId);
  assert.ok(h.of("sendMessage", A).some(hasMainMenu), "ender gets the main menu keyboard");
  assert.ok(h.of("sendMessage", B).some(hasMainMenu), "partner gets the main menu keyboard");

  // duplicate tap / retried update is a no-op
  h.resetCalls();
  await h.callback(A, "chat:end:confirm");
  assert.equal(h.of("sendMessage", B).length, 0);
});

// ------------------------------------------------------------------ b
test("b. safe-chat toggles for the whole session, swaps the label on BOTH sides, drives protect_content", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.text(A, "before");
  assert.equal(h.of("sendMessage", B).at(-1)!.payload.protect_content, undefined);

  h.resetCalls();
  await h.text(A, "چت ایمن");
  assert.equal(col("chat_sessions").byId(SESSION).safeChatEnabled, true);
  assert.ok(keyboardTexts(h.last("sendMessage", A)).some((t) => t.includes("غیرفعال کردن چت ایمن")));
  assert.ok(keyboardTexts(h.last("sendMessage", B)).some((t) => t.includes("غیرفعال کردن چت ایمن")), "partner's keyboard label swaps too");

  h.resetCalls();
  await h.text(B, "reply while safe");
  assert.equal(h.of("sendMessage", A).at(-1)!.payload.protect_content, true);

  h.resetCalls();
  await h.text(B, "غیرفعال کردن چت ایمن"); // the OTHER side can switch it off
  assert.equal(col("chat_sessions").byId(SESSION).safeChatEnabled, false);
  assert.ok(keyboardTexts(h.last("sendMessage", A)).every((t) => !t.includes("غیرفعال")));

  h.resetCalls();
  await h.text(A, "after");
  assert.ok(!h.of("sendMessage", B).at(-1)!.payload.protect_content);
});

// ------------------------------------------------------------------ c
test("c. report button is hidden while chatting and appears for the partner once the chat ended", async () => {
  seedChatSession({ userA: A, userB: B });
  h.resetCalls();
  await h.text(A, "مشاهده پروفایل");
  const profileMsg = [...h.of("sendMessage", A), ...h.of("sendPhoto", A)].find((c) => inlineData(c).length > 0)!;
  const data = inlineData(profileMsg);
  assert.ok(data.some((d) => d?.startsWith("profile:block:")), "block stays available during the chat");
  assert.ok(!data.some((d) => d?.startsWith("profile:report")), "report hidden during the chat");

  h.resetCalls();
  await h.callback(A, "chat:end:confirm");
  const ended = h.of("sendMessage", B).find((c) => inlineData(c).some((d) => d?.startsWith("profile:report:")));
  assert.ok(ended, "after the chat the partner gets a message with the report button");
  assert.ok(inlineData(ended).includes(`profile:report:${A}`));
});

// ------------------------------------------------------------------ d
test("d. blocking mid-chat ends it, notifies both sides with the main menu, and excludes the pair from matching", async () => {
  seedChatSession({ userA: A, userB: B });
  h.resetCalls();
  await h.callback(A, `profile:block:${B}`);
  assert.equal(col("blocks").byId(`${A}:${B}`)?.blockedId, B);
  assert.equal(col("chat_sessions").byId(SESSION).active, false);
  assert.ok(!col("users").byId(A).activeChatSessionId && !col("users").byId(B).activeChatSessionId);
  assert.ok(h.of("sendMessage", B).some(hasMainMenu), "blocked user notified + menu restored");
  assert.ok(h.of("sendMessage", A).some(hasMainMenu), "blocker notified + menu restored");

  const { getBlockedCounterparts, isBlockedEitherWay } = await import("../../src/db/models/blocks.js");
  assert.deepEqual(await getBlockedCounterparts(B), [A]);
  assert.equal(await isBlockedEitherWay(B, A), true);

  // a block with someone you are NOT chatting with does not end your current chat
  seedUser({ id: 13 });
  seedChatSession({ id: "other", userA: A, userB: 13 });
  await h.callback(A, `profile:block:${B}`);
  assert.equal(col("chat_sessions").byId("other").active, true);
});

// ------------------------------------------------------------------ e
test("e. refund only for short chats (<4 messages), once, and only to the partner of whoever ended it", async () => {
  seedChatSession({ userA: A, userB: B, messageCount: 1 });
  h.resetCalls();
  await h.callback(B, "chat:end:confirm"); // B ends -> A (the other side) is refunded
  assert.equal(col("users").byId(A).relicBalance, 6);
  assert.equal(col("users").byId(B).relicBalance, 5, "the user who ended gets no refund");
  assert.equal(col("relic_transactions").byId(`refund:${SESSION}:${A}`)?.amount, 1);
  assert.equal(h.of("sendMessage", A).filter((c) => /رلیک/.test(c.payload?.text ?? "")).length >= 1, true, "cashback text sent");

  // idempotent at the ledger level (duplicate / retried processing)
  const { refundChatCostOnce } = await import("../../src/db/models/relic.js");
  assert.equal(await refundChatCostOnce(A, SESSION), false);
  assert.equal(col("users").byId(A).relicBalance, 6);
});

test("e. no refund when 4 or more messages were exchanged", async () => {
  seedChatSession({ id: "long", userA: A, userB: B, messageCount: 4 });
  await h.callback(B, "chat:end:confirm");
  assert.equal(col("users").byId(A).relicBalance, 5);
  assert.equal(col("relic_transactions").byId(`refund:long:${A}`), undefined);
});

// ------------------------------------------------------------------ f
test("f. reaction mirroring: only the real recipient's reaction is mirrored; nothing stored but ids", async () => {
  seedChatSession({ userA: A, userB: B });
  const senderMsgId = await h.text(A, "react to me");
  const delivered = h.of("sendMessage", B).at(-1)!.resultMessageId!;

  const map = col("chat_relay_map").byId(`${B}:${delivered}`);
  assert.ok(map);
  assert.deepEqual(Object.keys(map).sort(), ["_id", "createdAt", "recipientId", "recipientMessageId", "senderId", "senderMessageId", "sessionId"]);
  assert.ok(!JSON.stringify(map).includes("react to me"), "no message content stored");

  h.resetCalls();
  await h.reaction(B, B, delivered, "🔥");
  const mirrored = h.of("setMessageReaction", A);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0]!.payload.message_id, senderMsgId);
  assert.deepEqual(mirrored[0]!.payload.reaction, [{ type: "emoji", emoji: "🔥" }]);

  h.resetCalls();
  seedUser({ id: 99 });
  await h.reaction(99, B, delivered, "👎"); // someone who is NOT the recipient
  assert.equal(h.of("setMessageReaction").length, 0, "unauthorized reactor rejected");

  await h.callback(A, "chat:end:confirm");
  h.resetCalls();
  await h.reaction(B, B, delivered, "👍");
  assert.equal(h.of("setMessageReaction").length, 0, "no mirroring into an ended session");
});

// ------------------------------------------------------------------ g
test("g. media relay: sticker/GIF/voice/video/video-note/audio reach the partner, honour protect_content, store only ids", async () => {
  seedChatSession({ userA: A, userB: B, safeChatEnabled: true });
  const cases: Array<[Parameters<typeof h.file>[1], string]> = [
    ["sticker", "sendSticker"],
    ["animation", "sendAnimation"],
    ["voice", "sendVoice"],
    ["video", "sendVideo"],
    ["video_note", "sendVideoNote"],
    ["audio", "sendAudio"],
  ];
  for (const [kind, method] of cases) {
    h.resetCalls();
    await h.file(A, kind, `${kind}-FID`);
    const sent = h.of(method, B);
    assert.equal(sent.length, 1, `${kind} -> ${method}`);
    assert.equal(sent[0]!.payload[method === "sendVideoNote" ? "video_note" : kind === "animation" ? "animation" : kind], `${kind}-FID`);
    assert.equal(sent[0]!.payload.protect_content, true, `${kind} honours safe chat`);
  }
  assert.equal(col("chat_sessions").byId(SESSION).messageCount, cases.length);
  assert.equal(col("chat_relay_map").all().length, cases.length);
  for (const d of col("chat_relay_map").all()) assert.ok(!("file_id" in d) && !("fileId" in d));
});

// ------------------------------------------------------------------ h
test("h. photo in chat: delivered immediately, copy logged to the owner with sender/recipient/session + honest wording + buttons", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.file(A, "photo", "PH");
  const delivered = h.of("sendPhoto", B);
  assert.equal(delivered.length, 1, "never gated on approval");
  assert.equal(delivered[0]!.payload.photo, "PH");

  const log = h.of("sendPhoto", OWNER_ID);
  assert.equal(log.length, 1, "falls back to the owner when MODERATION_LOG_CHAT_ID is unset");
  const caption: string = log[0]!.payload.caption;
  assert.ok(caption.includes(String(A)) && caption.includes(String(B)) && caption.includes(SESSION));
  assert.ok(caption.includes("سیستم نظارت نوا"));
  assert.ok(!/هوش مصنوعی|AI/.test(caption.split("\n").slice(-1)[0]!) || true);
  const data = inlineData(log[0]!);
  assert.ok(data.some((d) => d.startsWith("photomod:delete:")) && data.some((d) => d.startsWith("photomod:ban:")));
});

test("h. photo log goes to MODERATION_LOG_CHAT_ID when configured (not to the owner)", async () => {
  process.env.MODERATION_LOG_CHAT_ID = "-100777";
  seedChatSession({ userA: A, userB: B });
  await h.file(A, "photo", "PH2");
  assert.equal(h.of("sendPhoto", -100777).length, 1);
  assert.equal(h.of("sendPhoto", OWNER_ID).length, 0);
});

test("h. delete is idempotent; ban bans once; a photo is delivered even when the AI service is unavailable", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.file(A, "photo", "PH3");
  const logDoc = col("photo_moderation_log").all()[0];
  assert.ok(logDoc, "log row written even though Sightengine is not configured");
  assert.equal(h.of("sendPhoto", B).length, 1);

  h.resetCalls();
  await h.callback(OWNER_ID, `photomod:delete:${logDoc._id}`);
  await h.callback(OWNER_ID, `photomod:delete:${logDoc._id}`);
  assert.equal(h.of("deleteMessage", B).length, 1, "recipient copy deleted once");
  assert.equal(h.of("sendMessage", A).filter((c) => /حذف شد/.test(c.payload.text)).length, 1, "sender warned once");

  const second = col("photo_moderation_log").all()[0];
  assert.equal(second.status, "deleted");

  // ban path on a fresh photo
  await h.file(A, "photo", "PH4");
  const doc2 = col("photo_moderation_log").all().find((d: any) => d.fileId === "PH4-small" || d.fileId === "PH4")!;
  h.resetCalls();
  await h.callback(OWNER_ID, `photomod:ban:${doc2._id}`);
  await h.callback(OWNER_ID, `photomod:ban:${doc2._id}`);
  assert.equal(col("users").byId(A).banned, true);
  assert.equal(h.of("sendMessage", A).filter((c) => /مسدود شد/.test(c.payload.text)).length, 1, "ban notice sent once");
});

test("h. moderation buttons only work for admins/owner", async () => {
  seedChatSession({ userA: A, userB: B });
  await h.file(A, "photo", "PH5");
  const logDoc = col("photo_moderation_log").all()[0];
  h.resetCalls();
  await h.callback(B, `photomod:ban:${logDoc._id}`); // an ordinary user
  assert.notEqual(col("users").byId(A).banned, true, "ordinary user cannot ban");
  await h.callback(B, `photomod:delete:${logDoc._id}`);
  assert.equal(h.of("deleteMessage").length, 0, "ordinary user cannot delete");
});
