/**
 * Cheap language guess used before the Router runs (blocked requests never reach the LLM,
 * but still deserve an answer in the merchant's language). The Router's detection wins later.
 * Word boundaries use Unicode letters, since JS `\\b` ignores accented characters.
 */
const word = (words: string) => new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, 'giu');

const PT = word('não|nao|você|voce|minha|meu|minhas|meus|quero|quando|como|vendas|maquininha|obrigad[oa]|olá|ola|está|preciso|dinheiro|cartão|dúvida|recebo|caem?|ontem|hoje|\\p{L}+ção|\\p{L}+ções');
const ES = word('quiero|cuándo|ventas|dinero|necesito|hola|gracias|usted|cómo|dónde|tarjeta|ayer|hoy|mis');

export function detectLanguage(text: string): string {
  const pt = text.match(PT)?.length ?? 0;
  const es = text.match(ES)?.length ?? 0;
  if (pt === 0 && es === 0) return 'en';
  return pt >= es ? 'pt' : 'es';
}
