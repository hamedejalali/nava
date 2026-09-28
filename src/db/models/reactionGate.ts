import { getDb } from "../connect.js";

/**
 * "گیت ری‌اکشن" — an admin-configurable gate, like force-join, but it can't
 * be verified through Telegram (the Bot API can't tell whether someone
 * reacted to a channel post), so it's purely time-based: when the gate is
 * shown to a user a private 10-second timer starts (the user never sees
 * it); pressing «بررسی» before it elapses says "not done yet", after it
 * elapses the user passes.
 *
 * `version` bumps whenever the message/button/link changes, so a NEW
 * challenge makes everyone pass again, while simply toggling the SAME
 * gate off and on does not.
 */
export interface ReactionGateSettings {
  enabled: boolean;
  message: string;
  buttonText: string;
  buttonUrl: string;
  version: number;
}

export const GATE_WAIT_MS = 10_000;

export const DEFAULT_GATE_SETTINGS: ReactionGateSettings = {
  enabled: false,
  message: "برای ادامه‌ی استفاده از ربات، ابتدا کار زیر رو انجام بده 👇",
  buttonText: "انجام بده",
  buttonUrl: "",
  version: 1,
};

interface SettingsDoc extends ReactionGateSettings {
  _id: "settings";
  updatedAt: Date;
  updatedBy?: number;
}

interface UserGateDoc {
  _id: number;
  startedVersion?: number;
  startedAt?: Date;
  passedVersion?: number;
}

async function settingsCol() {
  return (await getDb()).collection<SettingsDoc>("reaction_gate");
}
async function usersCol() {
  return (await getDb()).collection<UserGateDoc>("reaction_gate_users");
}

export async function getGateSettings(): Promise<ReactionGateSettings> {
  const doc = await (await settingsCol()).findOne({ _id: "settings" });
  if (!doc) return { ...DEFAULT_GATE_SETTINGS };
  return {
    enabled: doc.enabled ?? false,
    message: doc.message ?? DEFAULT_GATE_SETTINGS.message,
    buttonText: doc.buttonText ?? DEFAULT_GATE_SETTINGS.buttonText,
    buttonUrl: doc.buttonUrl ?? "",
    version: doc.version ?? 1,
  };
}

export async function setGateEnabled(enabled: boolean, adminId: number): Promise<void> {
  await (await settingsCol()).updateOne(
    { _id: "settings" },
    { $set: { enabled, updatedAt: new Date(), updatedBy: adminId }, $setOnInsert: { version: 1 } },
    { upsert: true }
  );
}

/** Changing what the gate asks for starts a NEW challenge (version + 1). */
export async function setGateField(field: "message" | "buttonText" | "buttonUrl", value: string, adminId: number): Promise<void> {
  await (await settingsCol()).updateOne(
    { _id: "settings" },
    { $set: { [field]: value, updatedAt: new Date(), updatedBy: adminId }, $inc: { version: 1 } },
    { upsert: true }
  );
}

/** Records that the gate was shown; the timer starts only the FIRST time
 *  for this version (re-showing it never resets a user's timer). */
export async function markGateShown(userId: number, version: number): Promise<void> {
  const col = await usersCol();
  await col.updateOne(
    { _id: userId, startedVersion: { $ne: version } },
    { $set: { startedVersion: version, startedAt: new Date() } },
    { upsert: true }
  ).catch((err: any) => {
    // Two near-simultaneous first shows race on the upsert — harmless.
    if (err?.code !== 11000) throw err;
  });
}

export async function hasPassedGate(userId: number, version: number): Promise<boolean> {
  const doc = await (await usersCol()).findOne({ _id: userId });
  return doc?.passedVersion === version;
}

/** Milliseconds since this user first saw the current version, or null if
 *  they never have. */
export async function gateElapsedMs(userId: number, version: number): Promise<number | null> {
  const doc = await (await usersCol()).findOne({ _id: userId });
  if (!doc || doc.startedVersion !== version || !doc.startedAt) return null;
  return Date.now() - doc.startedAt.getTime();
}

export async function markGatePassed(userId: number, version: number): Promise<void> {
  await (await usersCol()).updateOne({ _id: userId }, { $set: { passedVersion: version } }, { upsert: true });
}
