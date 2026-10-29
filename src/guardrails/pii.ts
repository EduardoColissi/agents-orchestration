/**
 * Masks sensitive identifiers before the message reaches logs or the LLM.
 * Card numbers are validated with Luhn to avoid masking order numbers, phone numbers, etc.
 */

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;
const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface MaskResult {
  text: string;
  /** Kinds of data found, e.g. ["card", "cpf"]. */
  found: string[];
}

export function maskPII(input: string): MaskResult {
  const found = new Set<string>();
  let text = input.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      found.add('card');
      return `[CARD ****${digits.slice(-4)}]`;
    }
    return match;
  });
  text = text.replace(CNPJ, () => (found.add('cnpj'), '[CNPJ]'));
  text = text.replace(CPF, () => (found.add('cpf'), '[CPF]'));
  text = text.replace(EMAIL, () => (found.add('email'), '[EMAIL]'));
  return { text, found: [...found] };
}
