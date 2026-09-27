import { MongoClient, type Db } from "mongodb";
import { env } from "../config/env.js";

/**
 * Serverless-safe MongoDB connection.
 *
 * Vercel may reuse a "warm" function instance for consecutive invocations.
 * We cache the client on the Node.js global object so a warm invocation
 * reuses the existing connection pool instead of opening a new one every
 * request (which would exhaust MongoDB connections under load).
 *
 * On a cold start, `globalThis.__navaMongo` is undefined and a fresh
 * connection is created and cached for subsequent invocations of the same
 * instance.
 *
 * IMPORTANT (fixed): if `createConnection()` rejects (a transient Atlas
 * blip, DNS hiccup, temporary network partition, ...), the REJECTED promise
 * used to stay cached in `connecting` forever. Every later call saw
 * `cached.connecting` was truthy and returned that SAME already-rejected
 * promise — so one transient failure permanently broke every request on
 * that warm container until Vercel eventually recycled it (which can take
 * a long time). We now clear the cache on failure so the very next call
 * gets a fresh connection attempt instead of replaying the old error.
 */

declare global {
  // eslint-disable-next-line no-var
  var __navaMongo:
    | { client: MongoClient; db: Db; connecting: Promise<Db> | null }
    | undefined;
}

async function createConnection(): Promise<Db> {
  const client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 10,
    minPoolSize: 0,
    // Fail fast instead of hanging a serverless invocation indefinitely.
    serverSelectionTimeoutMS: 8000,
  });

  await client.connect();
  const db = client.db(env.MONGODB_DB_NAME);

  globalThis.__navaMongo = { client, db, connecting: null };
  return db;
}

export async function getDb(): Promise<Db> {
  const cached = globalThis.__navaMongo;

  if (cached?.db) {
    return cached.db;
  }

  if (cached?.connecting) {
    return cached.connecting;
  }

  const connecting = createConnection().catch((err) => {
    // Reset so the NEXT call retries fresh instead of replaying this same
    // rejection forever on this warm instance.
    if (globalThis.__navaMongo?.connecting === connecting) {
      globalThis.__navaMongo = undefined;
    }
    // eslint-disable-next-line no-console
    console.error("[db] MongoDB connection attempt failed (will retry on next call):", err);
    throw err;
  });
  globalThis.__navaMongo = { client: null as unknown as MongoClient, db: null as unknown as Db, connecting };
  const db = await connecting;
  return db;
}

/** Exposes the underlying MongoClient for operations that need a session
 *  (multi-document transactions), e.g. the matchmaking engine. */
export async function getClient(): Promise<MongoClient> {
  await getDb(); // ensures a connection exists and is cached
  return globalThis.__navaMongo!.client;
}
