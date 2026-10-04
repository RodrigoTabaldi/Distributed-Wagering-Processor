import { describe, expect, it } from 'bun:test';
import { InboxMessage, InvalidInboxMessageError } from './inbox-message.js';

const props = () => ({
  messageId: 'message',
  consumerName: 'wager-consumer',
  payloadHash: 'a'.repeat(64),
  receivedAt: new Date('2026-10-03T10:00:00Z'),
});
describe('InboxMessage', () => {
  it('receives a pending message and records completion once', () => {
    const message = InboxMessage.receive(props());
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
    const at = new Date('2026-10-03T10:00:01Z');
    message.markProcessed(at);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at);
    // A primeira conclusão é histórica: a redelivery não pode substituir sua data.
    expect(() => message.markProcessed(at)).toThrow(InvalidInboxMessageError);
  });
  it('rehydrates both pending and completed messages without running their operation', () => {
    const incoming = { ...props(), processedAt: props().receivedAt };
    expect(InboxMessage.receive(incoming).isProcessed()).toBe(false);
    expect(InboxMessage.rehydrate(props()).isProcessed()).toBe(false);
    expect(
      InboxMessage.rehydrate({
        ...props(),
        processedAt: props().receivedAt,
      }).isProcessed(),
    ).toBe(true);
  });
  it('protects dates and identity against external mutation', () => {
    const input = props();
    const message = InboxMessage.receive(input);
    input.receivedAt.setFullYear(2000);
    message.receivedAt.setFullYear(2001);
    const at = new Date('2026-10-03T10:00:01Z');
    message.markProcessed(at);
    at.setFullYear(2002);
    message.processedAt!.setFullYear(2003);
    expect(message.receivedAt).toEqual(props().receivedAt);
    expect(message.processedAt?.getUTCFullYear()).toBe(2026);
    expect(Object.isFrozen(message)).toBe(true);
  });
  it.each(['messageId', 'consumerName'] as const)(
    'rejects empty or untrimmed %s',
    (field) => {
      for (const value of ['', ' ', ' name '])
        expect(() =>
          InboxMessage.receive({ ...props(), [field]: value }),
        ).toThrow(InvalidInboxMessageError);
    },
  );
  it.each(['short', 'g'.repeat(64), 'A'.repeat(64)])(
    'rejects invalid hash %s',
    (payloadHash) => {
      expect(() => InboxMessage.receive({ ...props(), payloadHash })).toThrow(
        InvalidInboxMessageError,
      );
    },
  );
  it('rejects invalid dates and processing before receipt', () => {
    const invalid = new Date(NaN);
    expect(() =>
      InboxMessage.receive({ ...props(), receivedAt: invalid }),
    ).toThrow(InvalidInboxMessageError);
    const message = InboxMessage.receive(props());
    for (const at of [invalid, new Date('2026-10-03T09:59:59Z')]) {
      expect(() => message.markProcessed(at)).toThrow(InvalidInboxMessageError);
      expect(() =>
        InboxMessage.rehydrate({ ...props(), processedAt: at }),
      ).toThrow(InvalidInboxMessageError);
    }
  });
});
