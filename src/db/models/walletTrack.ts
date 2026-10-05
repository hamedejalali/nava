import { WalletError, ledgerCol, normalizeTxCode, type WalletLedgerDoc } from "./walletCore.js";

/** Admin lookup by tracking code: the row plus everything linked to it (refund rows, the refunded original). */
export async function trackByCode(input: unknown): Promise<{ row: WalletLedgerDoc; related: WalletLedgerDoc[] }> {
  const code = normalizeTxCode(input);
  if (!code) throw new WalletError("invalid_code");
  const led = await ledgerCol();
  const row = await led.findOne({ code });
  if (!row) throw new WalletError("code_not_found", 404);
  const related = await led.find({ $or: [{ refundOf: row._id }, ...(row.kind === "refund" && row.refundOf ? [{ _id: row.refundOf }] : [])] }).toArray();
  return { row, related };
}
