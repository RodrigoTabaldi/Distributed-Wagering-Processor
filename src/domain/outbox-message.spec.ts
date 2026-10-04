import { describe, expect, it } from 'bun:test';
import { OutboxMessage } from './outbox-message.js';
import { WalletBalanceChanged } from './wager-events.js';
import { Money } from './money.js';
import { immutableJson } from './integration-event.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

const event = () =>
  new WalletBalanceChanged({
    eventId: crypto.randomUUID(),
    aggregateId: crypto.randomUUID(),
    correlationId: 'request',
    causationId: 'message',
    occurredAt: new Date('2026-10-04T00:00:00Z'),
    data: {
      transactionId: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '90.00', currency: 'BRL' },
      direction: LedgerDirection.Debit,
      money: { amount: '10.00', currency: 'BRL' },
      walletVersion: 2,
    },
  });
describe('integration event and Outbox domain', () => {
  it('serializes a stable versioned envelope with ISO dates and plain money', () => {
    const source = event();
    expect(source.toJSON()).toMatchObject({
      eventId: source.eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: source.aggregateId,
      version: 1,
      correlationId: 'request',
      causationId: 'message',
      occurredAt: '2026-10-04T00:00:00.000Z',
      data: {
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '90.00', currency: 'BRL' },
      },
    });
    expect(JSON.parse(JSON.stringify(source))).toEqual(source.toJSON());
  });
  it('protects nested data and date snapshots against mutation', () => {
    const source = event();
    source.occurredAt.setFullYear(2000);
    expect(source.occurredAt.getUTCFullYear()).toBe(2026);
    expect(Object.isFrozen(source.data.balanceAfter)).toBe(true);
    expect(Object.isFrozen(OutboxMessage.enqueue(source).payload)).toBe(true);
  });
  it('rejects a Money instance instead of MoneyProps in event data', () => {
    const source = event();
    expect(() =>
      immutableJson({ balanceAfter: Money.from(source.data.balanceAfter) }),
    ).toThrow('plain JSON');
  });
  it('retries with 1, 2, 4 seconds and caps the delay at a minute', () => {
    const message = OutboxMessage.enqueue(event());
    const now = new Date();
    expect(message.isDue(now)).toBe(true);
    for (let attempt = 1; attempt <= 9; attempt++) {
      message.scheduleRetry(now);
      expect(message.attempts).toBe(attempt);
      expect(message.nextAttemptAt?.getTime()).toBe(
        now.getTime() + Math.min(1000 * 2 ** (attempt - 1), 60000),
      );
    }
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(message.nextAttemptAt!)).toBe(true);
  });
  it('marks publication once and clears the retry agenda', () => {
    const message = OutboxMessage.enqueue(event());
    message.scheduleRetry(new Date());
    const at = new Date();
    message.markPublished(at);
    at.setFullYear(2000);
    expect(message.isPending()).toBe(false);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.isDue(new Date())).toBe(false);
    expect(() => message.scheduleRetry(new Date())).toThrow();
    expect(() => message.markPublished(new Date())).toThrow();
  });
  it('rehydrates retries and detects envelope identity corruption', () => {
    const message = OutboxMessage.enqueue(event());
    const state = {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: message.payload,
      occurredAt: message.occurredAt,
      attempts: 2,
      nextAttemptAt: new Date(Date.now() + 5000),
    };
    expect(OutboxMessage.rehydrate(state).attempts).toBe(2);
    expect(() =>
      OutboxMessage.rehydrate({ ...state, id: crypto.randomUUID() }),
    ).toThrow('identity');
    expect(() => OutboxMessage.rehydrate({ ...state, attempts: -1 })).toThrow(
      'attempts',
    );
    expect(() =>
      OutboxMessage.rehydrate({ ...state, occurredAt: new Date(NaN) }),
    ).toThrow('date');
  });
});
