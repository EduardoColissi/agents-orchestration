/**
 * Deterministic safety net for the Router's `live_data` flag, limited to the brief's own categories
 * (weather and exchange rates): when the question carries one of these words, Knowledge runs the web
 * search in code instead of trusting the 8B to pick the tool. Getnet vocabulary (fees, prices of
 * machines, Pix) is left out on purpose, so a product question never loses the knowledge base.
 */
const LIVE_DATA = /\b(cota[cç][aã]o|c[aâ]mbio|exchange rates?|d[oó]lar(?:es)?|euros?|libras? esterlinas?|bitcoin|previs[aã]o do tempo|weather|forecast|pron[oó]stico|vai chover)\b/i;

export function looksLikeLiveData(text: string): boolean {
  return LIVE_DATA.test(text);
}
