/** Pure helpers for scripts/explain-hot-queries.ts (kept separate so they can be unit-tested without a database). */

/** Every stage name in an explain() winning plan, walking inputStage / inputStages / queryPlan / shards (any depth). */
export function planStages(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, any>;
  if (typeof n.stage === "string") out.push(n.stage);
  for (const k of ["inputStage", "queryPlan", "winningPlan"]) if (n[k]) planStages(n[k], out);
  for (const k of ["inputStages", "shards"]) if (Array.isArray(n[k])) for (const c of n[k]) planStages(c, out);
  return out;
}

export type PlanVerdict = "IXSCAN" | "COLLSCAN" | "UNKNOWN";

/** COLLSCAN anywhere in the winning plan wins (one scanned branch of an $or is still a scan); IXSCAN only if there is one and no COLLSCAN;
 *  anything else (no stages found = unexpected explain shape) is UNKNOWN and is never reported as a pass. */
export function planVerdict(explain: unknown): PlanVerdict {
  const stages = planStages((explain as any)?.queryPlanner?.winningPlan);
  if (stages.includes("COLLSCAN")) return "COLLSCAN";
  if (stages.includes("IXSCAN") || stages.includes("EXPRESS_IXSCAN")) return "IXSCAN";
  return "UNKNOWN";
}

/** A required-index case passes only on a real IXSCAN. */
export function casePasses(mustUseIndex: boolean, verdict: PlanVerdict): boolean {
  return !mustUseIndex || verdict === "IXSCAN";
}
