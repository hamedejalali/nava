import { getDb } from "../connect.js";

/**
 * One record per Telegram `update_id` that reached the webhook. It makes webhook processing idempotent and
 * bounded: a duplicate delivery of an already-processed update is acknowledged without running handlers
 * again, a concurrent duplicate is told to come back later, and an update that keeps failing is parked as
 * "dead" after a bounded number of attempts instead of being retried forever. Only metadata is stored (never
 * the message content). Records expire after 3 days (TTL).
 */
export type InboxState = "processing" | "done" | "failed" | "dead";

export interface UpdateInboxDoc {
  _id: number; // Telegram update_id
  state: InboxState;
  attempts: number;
  leaseUntil?: Date;
  kind?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function inboxCollection() {
  return (await getDb()).collection<UpdateInboxDoc>("update_inbox");
}

export async function ensureUpdateInboxIndexes(): Promise<void> {
  const c = await inboxCollection();
  await c.createIndexes([{ key: { createdAt: 1 }, name: "created_ttl", expireAfterSeconds: 3 * 24 * 3600 }]);
}
