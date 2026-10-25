/**
 * Input guardrail (runs before any LLM call). Deterministic and cheap: catches the obvious
 * attacks; subtler cases are left to the Router, which can also return "blocked".
 */

export type BlockCategory = 'prompt_injection' | 'other_customer_data' | 'harmful';

export interface InputCheck {
  allowed: boolean;
  category?: BlockCategory;
  reason?: string;
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|your\s+|the\s+)?(previous\s+|prior\s+|above\s+)?(instructions|rules|prompt)/i,
  /(reveal|show|print|repeat)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions)/i,
  /\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\s+(an?\s+)?(admin|administrator|developer|DAN|unrestricted|jailbroken)\b/i,
  /\b(jailbreak|DAN mode|developer mode)\b/i,
  /ignore\s+(as\s+|suas\s+)?(instru[cç][oõ]es|regras)/i,
  /(esque[cç]a|desconsidere)\s+(as\s+|suas\s+|todas\s+)?(instru[cç][oõ]es|regras)/i,
  /<\/?\s*(system|assistant)\s*>/i,
];

const HARMFUL_PATTERNS: RegExp[] = [
  /\b(clon(e|ar|ing)|skimm(er|ing))\b.{0,30}\b(card|cart[aã]o|cart[oõ]es)/i,
  /\b(lavar|lavagem de|launder(ing)?)\s+(dinheiro|money)\b/i,
  /\b(stolen|roubad[oa]s?)\s+(cards?|cart[oõ]es|cart[aã]o)\b/i,
  /\b(fake|falsa?)\s+(chargeback|contesta[cç][aã]o)/i,
];

/**
 * Identifiers that look like another customer's id: "cliente2000", "customer_123", "user id: 42".
 * Plain amounts ("charge a client 300 reais") are not matched.
 */
const CUSTOMER_ID = /\b(?:(?:cliente|client|customer|user|usu[aá]rio)[_#-]?(\d{3,})|(?:user|customer|client)[\s_-]?id\s*[:#=]?\s*(\d{2,}))\b/gi;

export function checkInput(message: string, userId: string): InputCheck {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) return { allowed: false, category: 'prompt_injection', reason: `matched ${pattern.source}` };
  }
  for (const pattern of HARMFUL_PATTERNS) {
    if (pattern.test(message)) return { allowed: false, category: 'harmful', reason: `matched ${pattern.source}` };
  }
  const ownDigits = userId.replace(/\D/g, '');
  for (const match of message.matchAll(CUSTOMER_ID)) {
    if ((match[1] ?? match[2]) !== ownDigits) return { allowed: false, category: 'other_customer_data', reason: `references ${match[0]}` };
  }
  return { allowed: true };
}

export const BLOCKED_MESSAGES: Record<string, string> = {
  pt: 'Não posso ajudar com esse pedido. Posso responder dúvidas sobre produtos Getnet ou sobre a sua própria conta, vendas e maquininhas.',
  es: 'No puedo ayudar con esa solicitud. Puedo responder dudas sobre productos Getnet o sobre tu propia cuenta, ventas y terminales.',
  en: "I can't help with that request. I can answer questions about Getnet products or about your own account, sales and card machines.",
};
