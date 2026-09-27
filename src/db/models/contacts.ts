import { getDb } from "../connect.js";

interface ContactDoc {
  _id: string; // `${ownerId}:${contactId}`
  ownerId: number;
  contactId: number;
  addedAt: Date;
}

async function collection() {
  const db = await getDb();
  return db.collection<ContactDoc>("contacts");
}

export async function addContact(ownerId: number, contactId: number): Promise<boolean> {
  const col = await collection();
  try {
    await col.insertOne({ _id: `${ownerId}:${contactId}`, ownerId, contactId, addedAt: new Date() });
    return true;
  } catch (err: any) {
    if (err?.code === 11000) return false; // already a contact
    throw err;
  }
}

export async function removeContact(ownerId: number, contactId: number): Promise<void> {
  const col = await collection();
  await col.deleteOne({ _id: `${ownerId}:${contactId}` });
}

export async function isContact(ownerId: number, contactId: number): Promise<boolean> {
  const col = await collection();
  return !!(await col.findOne({ _id: `${ownerId}:${contactId}` }));
}

export async function listContacts(ownerId: number): Promise<number[]> {
  const col = await collection();
  const docs = await col.find({ ownerId }).sort({ addedAt: -1 }).toArray();
  return docs.map((d) => d.contactId);
}
