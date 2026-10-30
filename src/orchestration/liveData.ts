/**
 * Deterministic safety net for the Router's `live_data` flag, limited to the brief's own categories
 * (weather and exchange rates): when the question carries one of these words, Knowledge runs the web
 * search in code instead of trusting the 8B to pick the tool. Getnet vocabulary (fees, prices of
 * machines, Pix) is left out on purpose, so a product question never loses the knowledge base.
 */
const EXCHANGE = /\b(cota[cç][aã]o|c[aâ]mbio|exchange rates?|d[oó]lar(?:es)?|dollars?|euros?|libras?(?: esterlinas?)?|pounds?|bitcoin|ienes?|yen)\b/i;
const WEATHER = /\b(previs[aã]o do tempo|weather|forecast|pron[oó]stico|vai chover)\b/i;
const CURRENCIES: Array<[RegExp, string]> = [
  [/\beuros?\b/i, 'euro'],
  [/\bd[oó]lar(?:es)?\b|\bdollars?\b|\busd\b/i, 'dólar'],
  [/\blibras?\b|\bpounds?\b/i, 'libra esterlina'],
  [/\bbitcoin\b|\bbtc\b/i, 'bitcoin'],
  [/\bienes?\b|\byen\b/i, 'iene'],
];

export function looksLikeLiveData(text: string): boolean {
  return EXCHANGE.test(text) || WEATHER.test(text);
}

/**
 * The query Knowledge searches the web with. An exchange rate is asked in Portuguese against the
 * real: with the merchant's English question, Brave (country BR) led with a converter's
 * "1 EUR = 1.0000 EUR" and the 8B copied it. Anything else is the merchant's own question.
 */
export function liveDataQuery(question: string): string {
  if (!EXCHANGE.test(question)) return question;
  const currency = CURRENCIES.find(([re]) => re.test(question))?.[1];
  return currency ? `cotação do ${currency} hoje em reais` : `${question} cotação em reais`;
}
