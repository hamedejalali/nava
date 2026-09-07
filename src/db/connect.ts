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

  const connecting = createConnection();
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
