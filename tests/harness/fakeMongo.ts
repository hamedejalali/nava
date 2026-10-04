/**
 * In-memory fake of the (small) part of the `mongodb` driver this project
 * uses. Purely offline, no real MongoDB. See the "LIMITATIONS" block below
 * for what it does NOT prove.
 *
 * Install with `installFakeMongo()` BEFORE any src module calls getDb()
 * (it sets `globalThis.__navaMongo`, the exact cache src/db/connect.ts reads).
 *
 * Modelled:
 *  - Collections / Db / MongoClient surface used by src: collection(),
 *    findOne, find (+sort/skip/limit/project/toArray/async-iteration),
 *    insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne,
 *    deleteMany, findOneAndUpdate, findOneAndDelete, countDocuments,
 *    estimatedDocumentCount, aggregate ($match,$sample,$project,$sort,
 *    $skip,$limit), createIndex, createIndexes.
 *  - Query operators: equality (null matches missing/null, dotted paths,
 *    arrays), $eq $ne $in $nin $gt $gte $lt $lte $exists $type $not $and
 *    $or $nor. Unknown operators THROW (so nothing is silently ignored).
 *  - Update operators: $set $unset $inc $setOnInsert (+ upsert seeded from
 *    the filter's equality fields), replacement documents for replaceOne.
 *  - Driver quirks: `undefined` is stored as `null` (ignoreUndefined=false),
 *    inserted docs get an ObjectId `_id` and the caller's object is mutated,
 *    findOneAndUpdate returns the document (not {value}) unless
 *    includeResultMetadata, default returnDocument is "before".
 *  - Unique `_id` and unique indexes (incl. partialFilterExpression and
 *    sparse): a violation throws a real `MongoServerError` with code 11000
 *    and the usual "E11000 duplicate key error collection: db.col index: name
 *    dup key: {...}" message.
 *  - Sessions: client.startSession() -> session.withTransaction(fn) runs
 *    fn(session); every write made with `{ session }` is recorded in an undo
 *    log and ROLLED BACK if fn throws (error is re-thrown). endSession() ok.
 *  - Each public operation yields one microtask and then runs synchronously
 *    to completion, so two operations never interleave internally, but
 *    separate async flows (Promise.all) DO interleave between operations,
 *    like in the real driver.
 *
 * LIMITATIONS (what tests on top of this do NOT prove):
 *  - No real transaction isolation: writes inside a transaction are visible
 *    to everybody immediately (read-uncommitted), and WriteConflict /
 *    TransientTransactionError retries never happen. Rollback only restores
 *    documents written through that session.
 *  - Writes made WITHOUT `{session}` while a transaction is open are not
 *    rolled back (same as real MongoDB, but never conflict either).
 *  - TTL indexes (expireAfterSeconds) are recorded but documents never
 *    expire. No collation, text/geo indexes, change streams, $expr, $regex,
 *    array update operators ($push/$pull/...), $min/$max, bulkWrite,
 *    distinct, $group/$lookup and friends (they throw "unsupported").
 *  - Query planning/index usage and performance are not modelled; BSON type
 *    ordering is approximated; documents are limited to JSON-like values,
 *    Date, ObjectId and Buffer.
 */
import { MongoServerError, ObjectId } from "mongodb";

/* ------------------------------------------------------------------ */
/* value helpers                                                       */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, any> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Deep clone that also applies the driver's BSON quirk: undefined -> null. */
export function cloneBson<T>(v: T): T {
  if (v === undefined) return null as any;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return new Date(v.getTime()) as any;
  if (v instanceof ObjectId) return new ObjectId(v.toHexString()) as any;
  if (Buffer.isBuffer(v)) return Buffer.from(v) as any;
  if (v instanceof RegExp) return v;
  if (Array.isArray(v)) return v.map((x) => cloneBson(x)) as any;
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(v as any)) out[k] = cloneBson(val);
  return out as any;
}

/** Clone for READ results: keeps stored nulls, never produces undefined. */
function cloneOut<T>(v: T): T {
  return cloneBson(v);
}

function deepEq(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof ObjectId || b instanceof ObjectId) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEq(x, b[i]));
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEq(a[k], b[k]));
  }
  return false;
}

function idKey(id: unknown): string {
  if (id instanceof ObjectId) return `o:${id.toHexString()}`;
  if (id instanceof Date) return `d:${id.getTime()}`;
  if (id !== null && typeof id === "object") return `j:${JSON.stringify(id)}`;
  return `${typeof id}:${String(id)}`;
}

function rank(v: any): number {
  if (v === null || v === undefined) return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  if (Array.isArray(v)) return 5;
  if (v instanceof ObjectId) return 7;
  if (typeof v === "boolean") return 8;
  if (v instanceof Date) return 9;
  if (typeof v === "object") return 4;
  return 10;
}

/** Total order used for sorting (approximate BSON order). */
function compareForSort(a: any, b: any): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 1) return 0;
  if (ra === 2 || ra === 3) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 8) return a === b ? 0 : a ? 1 : -1;
  if (ra === 9) return a.getTime() - b.getTime();
  if (ra === 7) return a.toHexString() < b.toHexString() ? -1 : a.toHexString() > b.toHexString() ? 1 : 0;
  return 0;
}

/** Comparison for $gt/$lt...: only values of the same BSON type compare. */
function compareSameType(a: any, b: any): number | undefined {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return undefined;
  if (ra === 1) return 0;
  if (ra === 4 || ra === 5) return undefined;
  return compareForSort(a, b);
}

/* ------------------------------------------------------------------ */
/* path helpers                                                        */
/* ------------------------------------------------------------------ */

interface Resolved {
  exists: boolean;
  values: any[];
}

function resolvePath(doc: any, path: string): Resolved {
  const parts = path.split(".");
  const out: any[] = [];
  let exists = false;
  const walk = (cur: any, i: number) => {
    if (i === parts.length) {
      exists = true;
      out.push(cur);
      return;
    }
    if (cur === null || typeof cur !== "object") return;
    const part = parts[i]!;
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(part)) {
        if (Number(part) < cur.length) walk(cur[Number(part)], i + 1);
      } else {
        for (const el of cur) walk(el, i);
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(cur, part)) walk(cur[part], i + 1);
  };
  walk(doc, 0);
  return { exists, values: out };
}

function getPathValue(doc: any, path: string): any {
  const r = resolvePath(doc, path);
  return r.values[0];
}

function setPathValue(doc: any, path: string, value: any): void {
  const parts = path.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cur[p] === null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]!] = value;
}

function unsetPathValue(doc: any, path: string): void {
  const parts = path.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]!];
    if (cur === null || typeof cur !== "object") return;
  }
  if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]!];
}

/* ------------------------------------------------------------------ */
/* query matching                                                      */
/* ------------------------------------------------------------------ */

function isOperatorObject(v: unknown): v is Record<string, any> {
  return isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith("$"));
}

function eqMatch(res: Resolved, q: any): boolean {
  if (q === undefined) q = null;
  if (q === null) {
    if (!res.exists) return true;
    return res.values.some((v) => v === null || (Array.isArray(v) && v.includes(null)));
  }
  if (q instanceof RegExp) {
    return res.values.some((v) => (typeof v === "string" && q.test(v)) || (Array.isArray(v) && v.some((e) => typeof e === "string" && q.test(e))));
  }
  return res.values.some((v) => deepEq(v, q) || (Array.isArray(v) && v.some((e) => deepEq(e, q))));
}

const TYPE_ALIASES: Record<string, (v: any) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  int: (v) => typeof v === "number" && Number.isInteger(v),
  long: (v) => typeof v === "number" && Number.isInteger(v),
  double: (v) => typeof v === "number",
  decimal: (v) => typeof v === "number",
  bool: (v) => typeof v === "boolean",
  date: (v) => v instanceof Date,
  objectId: (v) => v instanceof ObjectId,
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => isPlainObject(v),
};

function applyFieldOps(res: Resolved, ops: Record<string, any>): boolean {
  for (const [op, arg0] of Object.entries(ops)) {
    const arg = arg0 === undefined ? null : arg0;
    switch (op) {
      case "$eq":
        if (!eqMatch(res, arg)) return false;
        break;
      case "$ne":
        if (eqMatch(res, arg)) return false;
        break;
      case "$in":
        if (!Array.isArray(arg)) throw new Error("FakeMongo: $in needs an array");
        if (!arg.some((x) => eqMatch(res, x))) return false;
        break;
      case "$nin":
        if (!Array.isArray(arg)) throw new Error("FakeMongo: $nin needs an array");
        if (arg.some((x) => eqMatch(res, x))) return false;
        break;
      case "$gt":
      case "$gte":
      case "$lt":
      case "$lte": {
        const ok = res.values.some((v) => {
          const cand = Array.isArray(v) ? v : [v];
          return cand.some((c) => {
            const c2 = compareSameType(c, arg);
            if (c2 === undefined) return false;
            return op === "$gt" ? c2 > 0 : op === "$gte" ? c2 >= 0 : op === "$lt" ? c2 < 0 : c2 <= 0;
          });
        });
        if (!ok) return false;
        break;
      }
      case "$exists":
        if (!!arg !== res.exists) return false;
        break;
      case "$type": {
        const names: string[] = Array.isArray(arg) ? arg : [arg];
        const ok = res.values.some((v) => {
          const cand = [v, ...(Array.isArray(v) ? v : [])];
          return cand.some((c) =>
            names.some((n) => {
              const fn = TYPE_ALIASES[n];
              if (!fn) throw new Error(`FakeMongo: unsupported $type "${n}"`);
              return fn(c);
            })
          );
        });
        if (!ok) return false;
        break;
      }
      case "$not":
        if (isOperatorObject(arg)) {
          if (applyFieldOps(res, arg)) return false;
        } else if (eqMatch(res, arg)) return false;
        break;
      default:
        throw new Error(`FakeMongo: unsupported query operator ${op}`);
    }
  }
  return true;
}

export function matches(doc: any, filter: Record<string, any> | undefined | null): boolean {
  if (!filter) return true;
  for (const [key, cond0] of Object.entries(filter)) {
    const cond = cond0 === undefined ? null : cond0;
    if (key === "$and") {
      if (!Array.isArray(cond) || !cond.every((f: any) => matches(doc, f))) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(cond) || !cond.some((f: any) => matches(doc, f))) return false;
      continue;
    }
    if (key === "$nor") {
      if (!Array.isArray(cond) || cond.some((f: any) => matches(doc, f))) return false;
      continue;
    }
    if (key.startsWith("$")) throw new Error(`FakeMongo: unsupported top-level query operator ${key}`);
    const res = resolvePath(doc, key);
    if (isOperatorObject(cond)) {
      if (!applyFieldOps(res, cond)) return false;
    } else if (!eqMatch(res, cond)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* update application                                                  */
/* ------------------------------------------------------------------ */

function mongoErr(message: string, code: number, extra: Record<string, unknown> = {}): MongoServerError {
  return new MongoServerError({ message, code, ...extra } as any);
}

function seedFromFilter(filter: Record<string, any>, into: Record<string, any>): void {
  for (const [k, v] of Object.entries(filter ?? {})) {
    if (k === "$and" && Array.isArray(v)) {
      v.forEach((f) => seedFromFilter(f, into));
      continue;
    }
    if (k.startsWith("$")) continue;
    if (isOperatorObject(v)) {
      if ("$eq" in v) setPathValue(into, k, cloneBson(v.$eq));
      continue;
    }
    if (v === undefined) continue;
    setPathValue(into, k, cloneBson(v));
  }
}

function applyUpdate(doc: Record<string, any>, update: Record<string, any>, isInsert: boolean): void {
  const keys = Object.keys(update);
  if (keys.length === 0 || keys.some((k) => !k.startsWith("$"))) {
    throw new Error("FakeMongo: Update document requires atomic operators (e.g. $set)");
  }
  const originalId = doc._id;
  for (const [op, spec0] of Object.entries(update)) {
    const spec = cloneBson(spec0) as Record<string, any>;
    switch (op) {
      case "$set":
        for (const [p, v] of Object.entries(spec)) setPathValue(doc, p, v);
        break;
      case "$setOnInsert":
        if (isInsert) for (const [p, v] of Object.entries(spec)) setPathValue(doc, p, v);
        break;
      case "$max":
      case "$min":
        for (const [p, v] of Object.entries(spec)) {
          const exists = resolvePath(doc, p).exists;
          const cur = getPathValue(doc, p);
          if (!exists || (op === "$max" ? v > cur : v < cur)) setPathValue(doc, p, v);
        }
        break;
      case "$unset":
        for (const p of Object.keys(spec)) unsetPathValue(doc, p);
        break;
      case "$inc":
        for (const [p, v] of Object.entries(spec)) {
          if (typeof v !== "number") throw mongoErr(`Cannot increment with non-numeric argument: {${p}: ${String(v)}}`, 14);
          const cur = getPathValue(doc, p);
          const exists = resolvePath(doc, p).exists;
          if (exists && cur !== null && typeof cur !== "number") {
            throw mongoErr(`Cannot apply $inc to a value of non-numeric type. {_id: ${String(doc._id)}} has the field '${p}' of non-numeric type ${typeof cur}`, 14);
          }
          setPathValue(doc, p, (typeof cur === "number" ? cur : 0) + v);
        }
        break;
      default:
        throw new Error(`FakeMongo: unsupported update operator ${op}`);
    }
  }
  if (originalId !== undefined && !deepEq(originalId, doc._id)) {
    throw mongoErr(`Performing an update on the path '_id' would modify the immutable field '_id'`, 66);
  }
}

/* ------------------------------------------------------------------ */
/* projection / sort                                                   */
/* ------------------------------------------------------------------ */

function applyProjection(doc: any, projection: Record<string, any> | undefined): any {
  if (!projection || Object.keys(projection).length === 0) return doc;
  const entries = Object.entries(projection);
  const includeKeys = entries.filter(([k, v]) => k !== "_id" && (v === 1 || v === true));
  const excludeKeys = entries.filter(([k, v]) => k !== "_id" && (v === 0 || v === false));
  if (includeKeys.length && excludeKeys.length) throw new Error("FakeMongo: cannot mix inclusion and exclusion in projection");
  const idSpec = projection._id;
  const dropId = idSpec === 0 || idSpec === false;
  if (includeKeys.length || (!excludeKeys.length && !dropId && entries.length)) {
    const out: any = {};
    if (!dropId && "_id" in doc) out._id = doc._id;
    for (const [k] of includeKeys) {
      const r = resolvePath(doc, k);
      if (r.exists) setPathValue(out, k, cloneOut(r.values[0]));
    }
    return out;
  }
  const out = cloneOut(doc);
  for (const [k] of excludeKeys) unsetPathValue(out, k);
  if (dropId) delete out._id;
  return out;
}

function sortDocs(docs: any[], sort: Record<string, 1 | -1 | "asc" | "desc"> | undefined): any[] {
  if (!sort || Object.keys(sort).length === 0) return docs;
  const keys = Object.entries(sort).map(([k, d]) => [k, d === -1 || d === "desc" ? -1 : 1] as const);
  return docs
    .map((d, i) => [d, i] as const)
    .sort(([a, ia], [b, ib]) => {
      for (const [k, dir] of keys) {
        const c = compareForSort(getPathValue(a, k), getPathValue(b, k));
        if (c !== 0) return c * dir;
      }
      return ia - ib;
    })
    .map(([d]) => d);
}

/* ------------------------------------------------------------------ */
/* sessions / transactions                                             */
/* ------------------------------------------------------------------ */

interface UndoEntry {
  col: FakeCollection;
  key: string;
  before: any | undefined;
}

export class FakeClientSession {
  inTransaction = false;
  hasEnded = false;
  private undo: UndoEntry[] = [];
  /** number of transactions committed / aborted on this session (for assertions) */
  commits = 0;
  aborts = 0;

  constructor(private readonly owner: FakeMongoClient) {}

  /** Mirrors the driver: runs fn(session); throw => abort (rollback) + rethrow. */
  async withTransaction<T>(fn: (session: FakeClientSession) => Promise<T>, _options?: unknown): Promise<T> {
    if (this.inTransaction) throw new Error("FakeMongo: Transaction already in progress");
    this.inTransaction = true;
    this.undo = [];
    this.owner.stats.transactionsStarted++;
    try {
      const result = await fn(this);
      this.inTransaction = false;
      this.undo = [];
      this.commits++;
      this.owner.stats.transactionsCommitted++;
      return result;
    } catch (err) {
      this.rollback();
      this.inTransaction = false;
      this.aborts++;
      this.owner.stats.transactionsAborted++;
      throw err;
    }
  }

  startTransaction(): void {
    if (this.inTransaction) throw new Error("FakeMongo: Transaction already in progress");
    this.inTransaction = true;
    this.undo = [];
  }
  async commitTransaction(): Promise<void> {
    this.inTransaction = false;
    this.undo = [];
    this.commits++;
  }
  async abortTransaction(): Promise<void> {
    this.rollback();
    this.inTransaction = false;
    this.aborts++;
  }

  async endSession(): Promise<void> {
    if (this.inTransaction) await this.abortTransaction();
    this.hasEnded = true;
  }

  /** @internal */
  record(col: FakeCollection, key: string, before: any | undefined): void {
    if (this.inTransaction) this.undo.push({ col, key, before });
  }

  private rollback(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const { col, key, before } = this.undo[i]!;
      if (before === undefined) col.rawDocs.delete(key);
      else col.rawDocs.set(key, before);
    }
    this.undo = [];
  }
}

/* ------------------------------------------------------------------ */
/* indexes                                                             */
/* ------------------------------------------------------------------ */

export interface FakeIndex {
  name: string;
  key: Record<string, 1 | -1 | string>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, any>;
}

function defaultIndexName(key: Record<string, any>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}_${v}`)
    .join("_");
}

const tick = () => Promise.resolve();

/* ------------------------------------------------------------------ */
/* cursor                                                              */
/* ------------------------------------------------------------------ */

export class FakeCursor<T = any> {
  private _sort?: Record<string, any>;
  private _skip = 0;
  private _limit = 0;
  private _projection?: Record<string, any>;
  private buffer?: T[];
  private pos = 0;

  constructor(
    private readonly compute: () => any[],
    opts: { sort?: any; skip?: number; limit?: number; projection?: any } = {}
  ) {
    this._sort = opts.sort;
    this._skip = opts.skip ?? 0;
    this._limit = opts.limit ?? 0;
    this._projection = opts.projection;
  }

  sort(spec: Record<string, any>): this {
    this._sort = spec;
    return this;
  }
  skip(n: number): this {
    this._skip = n;
    return this;
  }
  limit(n: number): this {
    this._limit = n;
    return this;
  }
  project(p: Record<string, any>): this {
    this._projection = p;
    return this;
  }

  private materialize(): T[] {
    if (this.buffer) return this.buffer;
    let docs = sortDocs(this.compute(), this._sort);
    if (this._skip) docs = docs.slice(this._skip);
    if (this._limit) docs = docs.slice(0, this._limit);
    this.buffer = docs.map((d) => cloneOut(applyProjection(d, this._projection)));
    return this.buffer;
  }

  async toArray(): Promise<T[]> {
    await tick();
    return this.materialize().slice(this.pos);
  }
  async hasNext(): Promise<boolean> {
    await tick();
    return this.pos < this.materialize().length;
  }
  async next(): Promise<T | null> {
    await tick();
    const b = this.materialize();
    return this.pos < b.length ? b[this.pos++]! : null;
  }
  async close(): Promise<void> {}
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    await tick();
    for (const d of this.materialize()) yield d;
  }
}

/* ------------------------------------------------------------------ */
/* collection                                                          */
/* ------------------------------------------------------------------ */

type Opts = { session?: FakeClientSession; [k: string]: any } | undefined;

export class FakeCollection<T extends Record<string, any> = any> {
  /** key(_id) -> stored document (insertion ordered). */
  readonly rawDocs = new Map<string, any>();
  readonly indexes: FakeIndex[] = [];

  constructor(
    readonly name: string,
    private readonly db: FakeDb
  ) {}

  /* ---------- internal sync primitives ---------- */

  private put(key: string, doc: any, session?: FakeClientSession): void {
    session?.record(this, key, this.rawDocs.has(key) ? this.rawDocs.get(key) : undefined);
    this.rawDocs.set(key, doc);
  }
  private remove(key: string, session?: FakeClientSession): void {
    if (!this.rawDocs.has(key)) return;
    session?.record(this, key, this.rawDocs.get(key));
    this.rawDocs.delete(key);
  }

  private dupError(idx: { name: string; key: Record<string, any> }, doc: any): MongoServerError {
    const keyValue: Record<string, any> = {};
    for (const f of Object.keys(idx.key)) keyValue[f] = getPathValue(doc, f) ?? null;
    const shown = Object.entries(keyValue)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
      .join(", ");
    return mongoErr(
      `E11000 duplicate key error collection: ${this.db.name}.${this.name} index: ${idx.name} dup key: { ${shown} }`,
      11000,
      { keyPattern: idx.key, keyValue }
    );
  }

  private indexApplies(idx: FakeIndex, doc: any): boolean {
    if (idx.partialFilterExpression && !matches(doc, idx.partialFilterExpression)) return false;
    if (idx.sparse && !Object.keys(idx.key).some((f) => resolvePath(doc, f).exists)) return false;
    return true;
  }

  private checkUnique(doc: any, selfKey: string | undefined): void {
    for (const idx of this.indexes) {
      if (!idx.unique || !this.indexApplies(idx, doc)) continue;
      const fields = Object.keys(idx.key);
      const mine = fields.map((f) => getPathValue(doc, f) ?? null);
      for (const [k, other] of this.rawDocs) {
        if (k === selfKey) continue;
        if (!this.indexApplies(idx, other)) continue;
        const theirs = fields.map((f) => getPathValue(other, f) ?? null);
        if (mine.every((v, i) => deepEq(v, theirs[i]))) throw this.dupError(idx, doc);
      }
    }
  }

  private insertSync(input: any, session?: FakeClientSession): any {
    if (input._id === undefined) input._id = new ObjectId();
    const doc = cloneBson(input);
    const key = idKey(doc._id);
    if (this.rawDocs.has(key)) throw this.dupError({ name: "_id_", key: { _id: 1 } }, doc);
    this.checkUnique(doc, undefined);
    this.put(key, doc, session);
    return doc._id;
  }

  private findKeys(filter: any, sort?: any, skip = 0, limit = 0): string[] {
    const hits: [string, any][] = [];
    for (const [k, d] of this.rawDocs) if (matches(d, filter)) hits.push([k, d]);
    let ordered = hits;
    if (sort && Object.keys(sort).length) {
      const sorted = sortDocs(
        hits.map(([, d]) => d),
        sort
      );
      ordered = sorted.map((d) => hits.find(([, x]) => x === d)!);
    }
    if (skip) ordered = ordered.slice(skip);
    if (limit) ordered = ordered.slice(0, limit);
    return ordered.map(([k]) => k);
  }

  /** Core of updateOne / findOneAndUpdate. Returns before/after images. */
  private updateOneSync(
    filter: any,
    update: any,
    opts: { upsert?: boolean; sort?: any; session?: FakeClientSession } | undefined
  ): { matched: boolean; before?: any; after?: any; upsertedId?: any; modified: boolean } {
    const [key] = this.findKeys(filter, opts?.sort, 0, 1);
    if (key !== undefined) {
      const before = this.rawDocs.get(key)!;
      const after = cloneBson(before);
      applyUpdate(after, update, false);
      const newKey = idKey(after._id);
      if (newKey !== key) throw mongoErr("immutable _id", 66);
      const changed = !deepEq(before, after);
      if (changed) {
        this.checkUnique(after, key);
        this.put(key, after, opts?.session);
      }
      return { matched: true, before: cloneOut(before), after: cloneOut(after), modified: changed };
    }
    if (!opts?.upsert) return { matched: false, modified: false };
    const doc: Record<string, any> = {};
    seedFromFilter(filter, doc);
    applyUpdate(doc, update, true);
    if (doc._id === undefined) doc._id = new ObjectId();
    const k = idKey(doc._id);
    if (this.rawDocs.has(k)) throw this.dupError({ name: "_id_", key: { _id: 1 } }, doc);
    this.checkUnique(doc, undefined);
    this.put(k, doc, opts?.session);
    return { matched: false, after: cloneOut(doc), upsertedId: doc._id, modified: true };
  }

  /* ---------- driver API ---------- */

  async insertOne(doc: T, opts?: Opts) {
    await tick();
    const insertedId = this.insertSync(doc, opts?.session);
    return { acknowledged: true, insertedId };
  }

  async insertMany(docs: T[], opts?: Opts) {
    await tick();
    const insertedIds: Record<number, any> = {};
    docs.forEach((d, i) => {
      insertedIds[i] = this.insertSync(d, opts?.session);
    });
    return { acknowledged: true, insertedCount: docs.length, insertedIds };
  }

  async findOne(filter: any = {}, opts?: Opts): Promise<T | null> {
    await tick();
    const [key] = this.findKeys(filter, opts?.sort, opts?.skip ?? 0, 1);
    if (key === undefined) return null;
    return cloneOut(applyProjection(this.rawDocs.get(key), opts?.projection)) as T;
  }

  find(filter: any = {}, opts?: Opts): FakeCursor<T> {
    return new FakeCursor<T>(() => this.findKeys(filter).map((k) => this.rawDocs.get(k)), {
      sort: opts?.sort,
      skip: opts?.skip,
      limit: opts?.limit,
      projection: opts?.projection,
    });
  }

  async countDocuments(filter: any = {}, _opts?: Opts): Promise<number> {
    await tick();
    return this.findKeys(filter).length;
  }

  async estimatedDocumentCount(): Promise<number> {
    await tick();
    return this.rawDocs.size;
  }

  async updateOne(filter: any, update: any, opts?: Opts) {
    await tick();
    const r = this.updateOneSync(filter, update, opts);
    return {
      acknowledged: true,
      matchedCount: r.matched ? 1 : 0,
      modifiedCount: r.matched && r.modified ? 1 : 0,
      upsertedCount: r.upsertedId !== undefined ? 1 : 0,
      upsertedId: r.upsertedId ?? null,
    };
  }

  async updateMany(filter: any, update: any, opts?: Opts) {
    await tick();
    const keys = this.findKeys(filter);
    let modified = 0;
    for (const key of keys) {
      const before = this.rawDocs.get(key)!;
      const after = cloneBson(before);
      applyUpdate(after, update, false);
      if (!deepEq(before, after)) {
        this.checkUnique(after, key);
        this.put(key, after, opts?.session);
        modified++;
      }
    }
    if (keys.length === 0 && opts?.upsert) {
      const r = this.updateOneSync(filter, update, opts);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: r.upsertedId };
    }
    return { acknowledged: true, matchedCount: keys.length, modifiedCount: modified, upsertedCount: 0, upsertedId: null };
  }

  async replaceOne(filter: any, replacement: any, opts?: Opts) {
    await tick();
    if (Object.keys(replacement).some((k) => k.startsWith("$"))) throw new Error("FakeMongo: replacement document must not contain operators");
    const [key] = this.findKeys(filter, undefined, 0, 1);
    if (key !== undefined) {
      const before = this.rawDocs.get(key)!;
      const after = cloneBson(replacement);
      after._id = before._id;
      this.checkUnique(after, key);
      this.put(key, after, opts?.session);
      return { acknowledged: true, matchedCount: 1, modifiedCount: deepEq(before, after) ? 0 : 1, upsertedCount: 0, upsertedId: null };
    }
    if (!opts?.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    const doc = cloneBson(replacement);
    if (doc._id === undefined) {
      const seeded: Record<string, any> = {};
      seedFromFilter(filter, seeded);
      doc._id = seeded._id ?? new ObjectId();
    }
    this.insertSync(doc, opts?.session);
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
  }

  async findOneAndUpdate(filter: any, update: any, opts?: Opts): Promise<any> {
    await tick();
    const r = this.updateOneSync(filter, update, opts);
    const want = opts?.returnDocument === "after" ? "after" : "before";
    const doc = r.matched ? r[want] : r.upsertedId !== undefined && want === "after" ? r.after : null;
    const projected = doc ? cloneOut(applyProjection(doc, opts?.projection)) : null;
    if (opts?.includeResultMetadata) {
      return { value: projected, ok: 1, lastErrorObject: { n: r.matched || r.upsertedId !== undefined ? 1 : 0, updatedExisting: r.matched } };
    }
    return projected;
  }

  async findOneAndDelete(filter: any, opts?: Opts): Promise<any> {
    await tick();
    const [key] = this.findKeys(filter, opts?.sort, 0, 1);
    let out: any = null;
    if (key !== undefined) {
      out = cloneOut(applyProjection(this.rawDocs.get(key), opts?.projection));
      this.remove(key, opts?.session);
    }
    if (opts?.includeResultMetadata) return { value: out, ok: 1, lastErrorObject: { n: out ? 1 : 0 } };
    return out;
  }

  async deleteOne(filter: any, opts?: Opts) {
    await tick();
    const [key] = this.findKeys(filter, undefined, 0, 1);
    if (key === undefined) return { acknowledged: true, deletedCount: 0 };
    this.remove(key, opts?.session);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter: any = {}, opts?: Opts) {
    await tick();
    const keys = this.findKeys(filter);
    for (const k of keys) this.remove(k, opts?.session);
    return { acknowledged: true, deletedCount: keys.length };
  }

  aggregate<R = any>(pipeline: Record<string, any>[], _opts?: Opts): FakeCursor<R> {
    return new FakeCursor<R>(() => {
      let docs: any[] = [...this.rawDocs.values()];
      for (const stage of pipeline) {
        const [name, spec] = Object.entries(stage)[0]!;
        switch (name) {
          case "$match":
            docs = docs.filter((d) => matches(d, spec));
            break;
          case "$sample": {
            const copy = [...docs];
            for (let i = copy.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [copy[i], copy[j]] = [copy[j], copy[i]];
            }
            docs = copy.slice(0, spec.size);
            break;
          }
          case "$project":
            docs = docs.map((d) => applyProjection(d, spec));
            break;
          case "$sort":
            docs = sortDocs(docs, spec);
            break;
          case "$skip":
            docs = docs.slice(spec);
            break;
          case "$limit":
            docs = docs.slice(0, spec);
            break;
          default:
            throw new Error(`FakeMongo: unsupported aggregation stage ${name}`);
        }
      }
      return docs;
    });
  }

  async createIndex(key: Record<string, any>, options: Record<string, any> = {}): Promise<string> {
    await tick();
    return this.addIndex({ key, ...options });
  }

  async createIndexes(specs: Array<{ key: Record<string, any>; [k: string]: any }>): Promise<string[]> {
    await tick();
    return specs.map((s) => this.addIndex(s));
  }

  private addIndex(spec: { key: Record<string, any>; [k: string]: any }): string {
    const name: string = spec.name ?? defaultIndexName(spec.key);
    const existing = this.indexes.find((i) => i.name === name);
    if (existing) return name; // idempotent like the server (same spec)
    const idx: FakeIndex = {
      name,
      key: spec.key,
      unique: !!spec.unique,
      sparse: !!spec.sparse,
      expireAfterSeconds: spec.expireAfterSeconds,
      partialFilterExpression: spec.partialFilterExpression,
    };
    if (idx.unique) {
      // validate existing data like the server does when building the index
      const saved = this.indexes.splice(0);
      try {
        this.indexes.push(idx);
        for (const [k, d] of this.rawDocs) this.checkUnique(d, k);
      } finally {
        this.indexes.length = 0;
        this.indexes.push(...saved);
      }
    }
    this.indexes.push(idx);
    return name;
  }

  /* ---------- test helpers (synchronous, not part of the driver) ---------- */

  /** All stored documents (deep copies). */
  all(): T[] {
    return [...this.rawDocs.values()].map((d) => cloneOut(d));
  }
  /** Documents matching a filter (deep copies). */
  where(filter: any = {}): T[] {
    return this.findKeys(filter).map((k) => cloneOut(this.rawDocs.get(k)));
  }
  /** One document by _id (deep copy) or undefined. */
  byId(id: unknown): T | undefined {
    const d = this.rawDocs.get(idKey(id));
    return d ? cloneOut(d) : undefined;
  }
  count(filter: any = {}): number {
    return this.findKeys(filter).length;
  }
  /** Synchronously insert (used by seeding helpers). */
  seed(doc: T): T {
    this.insertSync(doc);
    return cloneOut(this.rawDocs.get(idKey((doc as any)._id))!);
  }
  clear(): void {
    this.rawDocs.clear();
  }
}

/* ------------------------------------------------------------------ */
/* db / client                                                         */
/* ------------------------------------------------------------------ */

export class FakeDb {
  readonly collections = new Map<string, FakeCollection>();
  constructor(readonly name: string) {}

  /** Only `{ping:1}` is supported (used by the monitoring service). */
  async command(cmd: Record<string, any>): Promise<{ ok: number }> {
    if (cmd && cmd.ping === 1) return { ok: 1 };
    throw new Error("FakeMongo: unsupported db.command");
  }

  collection<T extends Record<string, any> = any>(name: string): FakeCollection<T> {
    let c = this.collections.get(name);
    if (!c) {
      c = new FakeCollection(name, this);
      this.collections.set(name, c);
    }
    return c as FakeCollection<T>;
  }
}

export class FakeMongoClient {
  readonly dbs = new Map<string, FakeDb>();
  readonly stats = { transactionsStarted: 0, transactionsCommitted: 0, transactionsAborted: 0 };

  async connect(): Promise<this> {
    return this;
  }
  async close(): Promise<void> {}
  db(name = "nava"): FakeDb {
    let d = this.dbs.get(name);
    if (!d) {
      d = new FakeDb(name);
      this.dbs.set(name, d);
    }
    return d;
  }
  startSession(_opts?: unknown): FakeClientSession {
    return new FakeClientSession(this);
  }
}

/* ------------------------------------------------------------------ */
/* installation + test helpers                                         */
/* ------------------------------------------------------------------ */

export interface FakeMongo {
  client: FakeMongoClient;
  db: FakeDb;
}

let current: FakeMongo | undefined;

/** Installs the fake as the process-wide connection cache. Idempotent. */
export function installFakeMongo(): FakeMongo {
  if (current && (globalThis as any).__navaMongo?.db === current.db) return current;
  const client = new FakeMongoClient();
  const db = client.db(process.env.MONGODB_DB_NAME || "nava");
  current = { client, db };
  (globalThis as any).__navaMongo = { client, db, connecting: null };
  return current;
}

export function getFakeMongo(): FakeMongo {
  if (!current) throw new Error("installFakeMongo() has not been called");
  return current;
}

/** Empties every collection (and resets transaction counters). Index
 *  definitions are kept (like a real database), unless dropIndexes is set. */
export function resetFakeMongo(opts: { dropIndexes?: boolean } = {}): void {
  const { db, client } = getFakeMongo();
  for (const c of db.collections.values()) {
    c.clear();
    if (opts.dropIndexes) c.indexes.length = 0;
  }
  client.stats.transactionsStarted = 0;
  client.stats.transactionsCommitted = 0;
  client.stats.transactionsAborted = 0;
}

/** Typed-ish direct access to a collection for assertions / seeding. */
export function col<T extends Record<string, any> = any>(name: string): FakeCollection<T> {
  return getFakeMongo().db.collection<T>(name);
}

/** Snapshot of every non-empty collection: { name: docs[] } */
export function dumpDb(): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const [name, c] of getFakeMongo().db.collections) {
    if (c.rawDocs.size > 0) out[name] = c.all();
  }
  return out;
}

let anonCounter = 0;

export interface SeedUserInput {
  id: number;
  [k: string]: any;
}

/** Inserts a fully-onboarded user straight into the fake DB. */
export function seedUser(input: SeedUserInput): any {
  const { id, ...rest } = input;
  anonCounter++;
  const doc = {
    _id: id,
    telegramId: id,
    firstName: `U${id}`,
    anonId: `user_T${String(id).slice(-4).padStart(4, "0")}${String(anonCounter).padStart(1, "0")}`.slice(0, 11),
    onboardingStep: "COMPLETED",
    languageCode: "fa",
    gender: id % 2 === 0 ? "female" : "male",
    age: 25,
    province: "تهران",
    city: "تهران",
    nickname: `nick${id}`,
    relicBalance: 10,
    relicInitialized: true,
    likesCount: 0,
    level: "newcomer",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...rest,
  };
  return col("users").seed(doc);
}

/** Creates an ACTIVE chat session between two (already seeded) users and
 *  points both users' activeChatSessionId at it. */
export function seedChatSession(input: {
  id?: string;
  userA: number;
  userB: number;
  messageCount?: number;
  safeChatEnabled?: boolean;
  active?: boolean;
}): any {
  const id = input.id ?? `sess-${input.userA}-${input.userB}`;
  const doc: any = {
    _id: id,
    userA: input.userA,
    userB: input.userB,
    active: input.active ?? true,
    createdAt: new Date(),
    messageCount: input.messageCount ?? 0,
  };
  if (input.safeChatEnabled !== undefined) doc.safeChatEnabled = input.safeChatEnabled;
  col("chat_sessions").seed(doc);
  if (doc.active) {
    for (const u of [input.userA, input.userB]) {
      const users = col("users");
      const existing = users.byId(u);
      if (!existing) throw new Error(`seedChatSession: user ${u} must be seeded first`);
      users.rawDocs.set(idKey(u), { ...users.rawDocs.get(idKey(u)), activeChatSessionId: id });
    }
  }
  return col("chat_sessions").byId(id);
}
