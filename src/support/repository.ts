/**
 * Data access contract for customer data. Tools depend on this interface only, so the
 * JSON mock can be swapped for Getnet's real APIs by adding another implementation.
 */
export interface CustomerRepository {
  getCustomer(userId: string): Promise<Customer | null>;
  getTransactions(userId: string, filter?: TransactionFilter): Promise<Transaction[]>;
  getSettlements(userId: string, filter?: SettlementFilter): Promise<Settlement[]>;
  getTerminals(userId: string): Promise<Terminal[]>;
  createTicket(input: NewTicket): Promise<Ticket>;
}

export interface Customer {
  userId: string;
  businessName: string;
  document: string;
  segment: string;
  city: string;
  plan: string;
  bankAccount: string;
  settlementPolicy: { debitBusinessDays: number; creditBusinessDays: number; pixBusinessDays: number };
}

export type PaymentMethod = 'debit' | 'credit' | 'pix';

export interface Transaction {
  id: string;
  /** ISO timestamp (local business time, no timezone conversion in the mock). */
  dateTime: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  brand: string;
  installments: number;
  status: 'approved' | 'declined';
  declineCode?: string;
}

export interface Settlement {
  saleDate: string;
  expectedDate: string;
  method: PaymentMethod;
  grossAmount: number;
  transactionIds: string[];
  status: 'scheduled' | 'paid';
  bankAccount: string;
}

export interface Terminal {
  serial: string;
  model: string;
  status: 'online' | 'offline';
  lastSeen: string;
  firmware: string;
  batteryPct: number;
  connectivity: { wifi: string; chip4g: string; lastError: string | null };
}

export interface Ticket {
  id: string;
  userId: string;
  category: TicketCategory;
  summary: string;
  createdAt: string;
  status: 'open';
}

export type TicketCategory = 'connectivity' | 'transaction_decline' | 'settlement' | 'human_handoff' | 'terminal_replacement' | 'other';

export interface NewTicket {
  /** Explicit id = idempotent creation (the same id is created once). */
  id?: string;
  userId: string;
  category: TicketCategory;
  summary: string;
}

export interface TransactionFilter {
  status?: 'approved' | 'declined';
  /** Only transactions from the last N days (0 = today only). */
  lastDays?: number;
}

export interface SettlementFilter {
  /** Settlements of sales made on this date (YYYY-MM-DD). */
  saleDate?: string;
  /** Only settlements not paid yet. */
  upcomingOnly?: boolean;
}
