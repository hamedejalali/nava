/**
 * Offline Telegram harness: builds the REAL bot (src/bot.ts createBot) on top
 * of the in-memory fake Mongo, replaces the network layer with a recorder,
 * and lets tests feed Update objects through bot.handleUpdate.
 *
 * What this proves: handler logic, routing/ordering of the middleware chain,
 * DB state changes, and the Bot API calls (method + payload) the bot would
 * have made. What it does NOT prove: Telegram's real behaviour (e.g. that
 * protect_content actually blocks forwarding, that a reply keyboard renders).
 */
import { installFakeMongo, resetFakeMongo } from "./fakeMongo.js";

export interface Call {
  method: string;
  payload: any;
  /** chat id the call targeted, when there is one */
  chatId?: number;
  /** message_id returned to the bot for send* calls */
  resultMessageId?: number;
}

export const OWNER_ID = 900;
export const ADMIN_ID = 901;

let env_set = false;
function setEnv(extra: Record<string, string | undefined> = {}) {
  if (!env_set) {
    Object.assign(process.env, {
      BOT_TOKEN: "123456:TEST-TOKEN",
      WEBHOOK_SECRET: "test-secret",
      MONGODB_URI: "mongodb://fake",
      MONGODB_DB_NAME: "nava_test",
      OWNER_ID: String(OWNER_ID),
      ADMIN_IDS: String(ADMIN_ID),
      PREMIUM_EMOJI_ENABLED: "false",
      NODE_ENV: "test",
    });
    delete process.env.MODERATION_LOG_CHAT_ID;
    delete process.env.SIGHTENGINE_API_USER;
    delete process.env.SIGHTENGINE_API_SECRET;
    env_set = true;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

let updateId = 1;
let nextMsgId = 1000;
const userMsgCounters = new Map<number, number>();

function from(id: number) {
  return { id, is_bot: false, first_name: `U${id}`, language_code: "fa" };
}
function sentMessageId(chatId: number): number {
  void chatId;
  return nextMsgId++;
}
function userMessageId(id: number): number {
  const n = (userMsgCounters.get(id) ?? 0) + 1;
  userMsgCounters.set(id, n);
  return n;
}

export type FileKind = "sticker" | "animation" | "voice" | "video" | "video_note" | "audio" | "photo";

export interface Harness {
  bot: any;
  calls: Call[];
  /** Calls of one Bot API method, optionally restricted to one chat. */
  of(method: string, chatId?: number): Call[];
  last(method: string, chatId?: number): Call | undefined;
  resetCalls(): void;
  /** Wait for fire-and-forget work (void promises, waitUntil, ...). */
  settle(): Promise<void>;
  text(userId: number, text: string, messageId?: number): Promise<number>;
  file(userId: number, kind: FileKind, fileId?: string): Promise<number>;
  callback(userId: number, data: string, onMessageId?: number, chatIdOverride?: number): Promise<void>;
  reaction(userId: number, chatId: number, messageId: number, emoji?: string): Promise<void>;
  /** Make a given Bot API method throw (e.g. 403 blocked by user) for a chat. */
  failFor(method: string, chatId: number, description?: string): void;
  clearFailures(): void;
}

export async function createHarness(extraEnv: Record<string, string | undefined> = {}): Promise<Harness> {
  setEnv(extraEnv);
  installFakeMongo();
  resetFakeMongo();
  // dynamic imports so that env + fake Mongo are in place first
  const { createBot } = await import("../../src/bot.js");
  const bot = createBot();
  bot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: "NavaTest",
    username: "NavaTestBot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as any;

  const calls: Call[] = [];
  const failures = new Set<string>();

  bot.api.config.use(async (_prev: any, method: string, payload: any) => {
    const chatId = typeof payload?.chat_id === "number" ? payload.chat_id : undefined;
    const call: Call = { method, payload, chatId };
    calls.push(call);
    if (chatId !== undefined && failures.has(`${method}:${chatId}`)) {
      return { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } as any;
    }
    let result: any = true;
    if (/^send/.test(method) || method === "copyMessage") {
      const id = sentMessageId(chatId ?? 0);
      call.resultMessageId = id;
      result = { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId ?? 0, type: "private" } };
    } else if (method === "getFile") {
      result = { file_id: payload.file_id, file_unique_id: "u", file_path: "photos/file_1.jpg" };
    } else if (method === "getChatMember") {
      result = { status: "member", user: from(payload.user_id) };
    } else if (method === "getMe") {
      result = bot.botInfo;
    }
    return { ok: true, result } as any;
  });

  const baseMessage = (userId: number) => ({
    message_id: userMessageId(userId),
    date: Math.floor(Date.now() / 1000),
    chat: { id: userId, type: "private" as const, first_name: `U${userId}` },
    from: from(userId),
  });

  const h: Harness = {
    bot,
    calls,
    of: (method, chatId) => calls.filter((c) => c.method === method && (chatId === undefined || c.chatId === chatId)),
    last: (method, chatId) => h.of(method, chatId).at(-1),
    resetCalls: () => void (calls.length = 0),
    async settle() {
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 15));
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    },
    async text(userId, text, messageId) {
      const msg: any = { ...baseMessage(userId), text };
      if (messageId) msg.message_id = messageId;
      if (text.startsWith("/")) msg.entities = [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }];
      await bot.handleUpdate({ update_id: updateId++, message: msg });
      await h.settle();
      return msg.message_id;
    },
    async file(userId, kind, fileId = `${kind}-file-id`) {
      const msg: any = baseMessage(userId);
      const f = { file_id: fileId, file_unique_id: `${fileId}-u`, file_size: 1000 };
      switch (kind) {
        case "sticker":
          msg.sticker = { ...f, type: "regular", width: 512, height: 512, is_animated: false, is_video: false };
          break;
        case "animation":
          msg.animation = { ...f, width: 100, height: 100, duration: 2 };
          break;
        case "voice":
          msg.voice = { ...f, duration: 3 };
          break;
        case "video":
          msg.video = { ...f, width: 100, height: 100, duration: 2 };
          break;
        case "video_note":
          msg.video_note = { ...f, length: 240, duration: 2 };
          break;
        case "audio":
          msg.audio = { ...f, duration: 3 };
          break;
        case "photo":
          msg.photo = [
            { ...f, file_id: `${fileId}-small`, width: 90, height: 90 },
            { ...f, width: 800, height: 800 },
          ];
          break;
      }
      await bot.handleUpdate({ update_id: updateId++, message: msg });
      await h.settle();
      return msg.message_id;
    },
    async callback(userId, data, onMessageId, chatIdOverride) {
      await bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: `cb-${updateId}`,
          from: from(userId),
          chat_instance: "ci",
          data,
          message: {
            message_id: onMessageId ?? 7777,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatIdOverride ?? userId, type: "private" },
            caption: "x",
          },
        },
      });
      await h.settle();
    },
    async reaction(userId, chatId, messageId, emoji = "👍") {
      await bot.handleUpdate({
        update_id: updateId++,
        message_reaction: {
          chat: { id: chatId, type: "private" },
          message_id: messageId,
          user: from(userId),
          date: Math.floor(Date.now() / 1000),
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji }],
        },
      });
      await h.settle();
    },
    failFor(method, chatId) {
      failures.add(`${method}:${chatId}`);
    },
    clearFailures() {
      failures.clear();
    },
  };
  return h;
}

/** Re-seeds the fake DB between tests without rebuilding the bot. */
export function resetState(): void {
  resetFakeMongo();
}
