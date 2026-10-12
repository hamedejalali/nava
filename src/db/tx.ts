import type { ClientSession } from "mongodb";
import { getClient } from "./connect.js";

/** Thrown inside a transaction body to abort it (everything written so far is rolled back) with a
 *  business-level outcome the caller handles, instead of an error. */
export class TxAbort extends Error {
  constructor(public readonly outcome: string) {
    super(`tx aborted: ${outcome}`);
  }
}

/**
 * Runs `fn` in a MongoDB transaction (retried by the driver on transient conflicts). The project already
 * relies on transactions for Relic balances/matching, so the deployment (Atlas replica set) supports them.
 * Used to keep "document + counter" pairs (likes, comments) consistent under crashes and concurrency.
 */
export async function runInTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = await getClient();
  const session = client.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}
