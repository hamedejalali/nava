import type { Collection } from "mongodb";
import { getDb } from "../connect.js";

export interface RequiredChannelDoc {
  _id: number; // sequential id, assigned at creation
  title: string;
  /** Used for Bot API membership checks — a public @username or a numeric chat id. */
  chatRef: string;
  /** URL the join button opens (usually https://t.me/<username>). */
  url: string;
  /** Short display handle shown in the force-join message text, e.g. "@nava". */
  handle: string;
  isActive: boolean;
  order: number;
  createdAt: Date;
}

const MAX_CHANNELS = 10;

async function channelsCollection(): Promise<Collection<RequiredChannelDoc>> {
  const db = await getDb();
  return db.collection<RequiredChannelDoc>("required_channels");
}

export async function listActiveChannels(): Promise<RequiredChannelDoc[]> {
  const col = await channelsCollection();
  return col.find({ isActive: true }).sort({ order: 1 }).toArray();
}

export async function listAllChannels(): Promise<RequiredChannelDoc[]> {
  const col = await channelsCollection();
  return col.find({}).sort({ order: 1 }).toArray();
}

export type AddChannelResult = { status: "added"; channel: RequiredChannelDoc } | { status: "limit_reached" };

export async function addChannel(input: { title: string; chatRef: string; url: string; handle: string }): Promise<AddChannelResult> {
  const col = await channelsCollection();
  const count = await col.countDocuments({});
  if (count >= MAX_CHANNELS) return { status: "limit_reached" };

  const last = await col.find({}).sort({ _id: -1 }).limit(1).toArray();
  const nextId = (last[0]?._id ?? 0) + 1;

  const channel: RequiredChannelDoc = {
    _id: nextId,
    title: input.title,
    chatRef: input.chatRef,
    url: input.url,
    handle: input.handle,
    isActive: true,
    order: nextId,
    createdAt: new Date(),
  };
  await col.insertOne(channel);
  return { status: "added", channel };
}

export async function toggleChannelActive(id: number): Promise<void> {
  const col = await channelsCollection();
  const doc = await col.findOne({ _id: id });
  if (!doc) return;
  await col.updateOne({ _id: id }, { $set: { isActive: !doc.isActive } });
}

export async function removeChannel(id: number): Promise<void> {
  const col = await channelsCollection();
  await col.deleteOne({ _id: id });
}
