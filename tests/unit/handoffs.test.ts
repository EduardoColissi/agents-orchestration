import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { ConversationStore } from '../../src/store/conversations.js';
import { HandoffAlreadyOpenError, HandoffStore } from '../../src/store/handoffs.js';

function setup(start = '2026-10-29T12:00:00Z') {
  let now = new Date(start);
  const clock = () => now;
  const db = openDb(':memory:');
  const conversations = new ConversationStore(db, clock);
  const handoffs = new HandoffStore(db, clock);
  const conversation = conversations.create('cliente1988');
  const open = () => handoffs.create({ conversationId: conversation.id, ownerId: 'cliente1988', kind: 'assist', reason: 'user_requested', request: { message: 'quero um humano', language: 'pt' }, ttlMinutes: 60 });
  return { db, conversations, handoffs, conversation, open, advance: (minutes: number) => (now = new Date(now.getTime() + minutes * 60_000)) };
}

describe('HandoffStore (FR20, FR21, FR23)', () => {
  it('creates a pending handoff with a protocol id and allows only one open per conversation', () => {
    const { open } = setup();
    const h = open();
    expect(h).toMatchObject({ status: 'pending', version: 1, kind: 'assist' });
    expect(h.id).toMatch(/^HND-[0-9A-F]{8}$/);
    expect(() => open()).toThrow(HandoffAlreadyOpenError);
  });

  it('resolves with compare-and-set: the stale or second resolve loses', () => {
    const { open, handoffs } = setup();
    const h = open();
    const first = handoffs.beginResume(h.id, 1, { action: 'reply', message: 'oi' }, 'op.ana');
    expect(first).toMatchObject({ status: 'resuming', version: 2, resolvedBy: 'op.ana', resolution: { action: 'reply', message: 'oi' } });
    expect(handoffs.beginResume(h.id, 1, { action: 'reject' }, 'op.bruno')).toBeNull();
    expect(handoffs.beginResume(h.id, 2, { action: 'reject' }, 'op.bruno')).toBeNull();
  });

  it('completes once and frees the conversation for a new handoff', () => {
    const { open, handoffs } = setup();
    const h = open();
    handoffs.beginResume(h.id, 1, { action: 'reject' }, 'op.ana');
    expect(handoffs.findResuming().map((x) => x.id)).toEqual([h.id]);
    expect(handoffs.complete(h.id)).toBe(true);
    expect(handoffs.complete(h.id)).toBe(false);
    expect(handoffs.get(h.id)).toMatchObject({ status: 'completed', version: 3 });
    expect(open().status).toBe('pending');
  });

  it('expires pending handoffs after the TTL, never resolved ones', () => {
    const { open, handoffs, advance } = setup();
    const h = open();
    advance(59);
    expect(handoffs.expireDue()).toEqual([]);
    advance(2);
    expect(handoffs.expireDue().map((x) => [x.id, x.status])).toEqual([[h.id, 'expired']]);
    expect(handoffs.beginResume(h.id, 2, { action: 'reply', message: 'late' }, 'op.ana')).toBeNull();
  });

  it('delivers a handoff outcome to the conversation exactly once', () => {
    const { open, conversations, conversation } = setup();
    const h = open();
    const deliver = () => conversations.addMessage({ conversationId: conversation.id, role: 'operator', content: 'Olá!', handoffId: h.id });
    expect([deliver(), deliver()]).toEqual([true, false]);
    expect(conversations.messages(conversation.id)).toHaveLength(1);
  });

  it('lists the queue in FIFO order', () => {
    const { db, handoffs, advance } = setup();
    const conversations = new ConversationStore(db);
    const ids = ['a', 'b'].map(() => {
      advance(1);
      return handoffs.create({ conversationId: conversations.create('cliente1988').id, ownerId: 'cliente1988', kind: 'assist', reason: 'r', request: { message: 'm', language: 'en' }, ttlMinutes: 60 }).id;
    });
    expect(handoffs.list().map((h) => h.id)).toEqual(ids);
  });
});
