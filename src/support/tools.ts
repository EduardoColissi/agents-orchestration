import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, json } from '../agents/defineTool.js';
import type { AgentTool } from '../agents/toolLoop.js';
import type { CustomerRepository } from './repository.js';

/** Standard ABECS response codes most often seen by merchants. */
export const DECLINE_CODES: Record<string, { meaning: string; action: string }> = {
  '05': { meaning: 'Not authorized by the card issuer (generic decline)', action: 'Ask the customer to contact their bank or use another card/payment method.' },
  '14': { meaning: 'Invalid card number', action: 'Check the card and try again, or use another card.' },
  '51': { meaning: 'Insufficient funds or credit limit', action: 'Ask the customer to use another card, payment method (e.g. Pix) or a lower amount.' },
  '54': { meaning: 'Expired card', action: 'Ask the customer for a valid card.' },
  '55': { meaning: 'Incorrect PIN', action: 'Ask the customer to retry with the correct PIN; after 3 attempts the card may be blocked.' },
  '57': { meaning: 'Transaction not permitted for this card', action: 'The card does not allow this type of purchase; use another card.' },
  '91': { meaning: 'Issuer unavailable', action: 'Wait a few minutes and retry; if it persists, use another payment method.' },
};

/** Models often wrap the serial ("Get Smart GS-1988-0001"): match a value that contains one of the merchant's serials. */
export function findTerminal<T extends { serial: string }>(terminals: T[], serial: string): T | undefined {
  const wanted = serial.toUpperCase();
  return terminals.find((t) => wanted === t.serial || wanted.includes(t.serial));
}

/**
 * Support tools bound to ONE customer. The user id comes from the orchestrator (the
 * authenticated request), never from the model, so cross-customer access is impossible (FR6).
 */
export function createSupportTools(repo: CustomerRepository, userId: string): AgentTool[] {
  return [
    defineTool(
      'get_customer_profile',
      "Get the merchant's profile: business name, plan, settlement policy (how many business days each payment method takes to be deposited) and the bank account where deposits go.",
      z.object({}),
      async () => {
        const customer = await repo.getCustomer(userId);
        return customer ? { content: json(customer) } : { content: json({ error: 'customer_not_found' }), isError: true };
      },
    ),

    defineTool(
      'get_settlements',
      'Get settlements (deposits of card/Pix sales into the bank account). Use sale_date to find when the sales of a given day will be/were deposited. Without sale_date, returns upcoming settlements. Amounts are gross (before fees).',
      z.object({
        sale_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Sales date in YYYY-MM-DD'),
      }),
      async ({ sale_date }) => {
        const settlements = await repo.getSettlements(userId, sale_date ? { saleDate: sale_date } : { upcomingOnly: true });
        const total = settlements.reduce((sum, s) => sum + s.grossAmount, 0);
        return { content: json({ sale_date: sale_date ?? null, settlements, total_gross_amount: Math.round(total * 100) / 100 }) };
      },
    ),

    defineTool(
      'get_transactions',
      'List recent card/Pix transactions, including declined ones with the decline code, its meaning and the recommended action.',
      z.object({
        status: z.enum(['approved', 'declined', 'all']).default('all'),
        last_days: z.number().int().min(0).max(30).default(7).describe('0 = today only'),
      }),
      async ({ status, last_days }) => {
        const txs = await repo.getTransactions(userId, { lastDays: last_days, ...(status !== 'all' ? { status } : {}) });
        const enriched = txs.map((t) => (t.declineCode ? { ...t, decline: DECLINE_CODES[t.declineCode] ?? { meaning: 'Unknown code', action: 'Open a support ticket.' } } : t));
        return { content: json({ count: enriched.length, transactions: enriched }) };
      },
    ),

    defineTool(
      'get_terminal_status',
      "Get the status and diagnostics of the merchant's card machines (online/offline, last seen, Wi-Fi and 4G chip status, last error, battery, firmware).",
      z.object({}),
      async () => ({ content: json({ terminals: await repo.getTerminals(userId) }) }),
    ),

    defineTool(
      'create_support_ticket',
      'Open a support ticket for a human team. Use only when the issue cannot be solved with the guidance given, or the merchant asks for it.',
      z.object({
        category: z.enum(['connectivity', 'transaction_decline', 'settlement', 'other']),
        summary: z.string().min(5).max(500).describe('Short description of the problem and what was already tried'),
      }),
      async ({ category, summary }) => {
        const ticket = await repo.createTicket({ userId, category, summary });
        return { content: json({ ticket_id: ticket.id, status: ticket.status }) };
      },
    ),

    defineTool(
      'request_terminal_replacement',
      "Request a replacement card machine for one of the merchant's terminals. Use ONLY when the merchant asks to replace/exchange the machine. A human specialist must approve it before it happens: never tell the merchant it was approved.",
      z.object({
        serial: z.string().min(3).max(40).describe('Serial of the merchant terminal to replace (from get_terminal_status)'),
        reason: z.string().min(5).max(300).describe('Why it should be replaced, based on the diagnostics'),
      }),
      async ({ serial, reason }, { idempotencyKey }) => {
        const terminal = findTerminal(await repo.getTerminals(userId), serial);
        if (!terminal) return { content: json({ error: 'terminal_not_found', serial }), isError: true };
        // The approval (handoff) id makes the side effect idempotent: approved twice, created once.
        const id = idempotencyKey ? `TCK-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12).toUpperCase()}` : undefined;
        const ticket = await repo.createTicket({ ...(id ? { id } : {}), userId, category: 'terminal_replacement', summary: `Replace ${terminal.serial}: ${reason}` });
        // INSERT OR IGNORE returns the stored row: never report someone else's ticket as ours.
        if (ticket.userId !== userId || ticket.category !== 'terminal_replacement') return { content: json({ error: 'ticket_id_conflict' }), isError: true };
        return { content: json({ ticket_id: ticket.id, status: ticket.status, serial: terminal.serial }) };
      },
      { requiresApproval: true },
    ),
  ];
}
