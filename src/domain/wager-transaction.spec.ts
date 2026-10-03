import { describe, expect, it } from 'bun:test';
import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';
import {
  FailureCode,
  IdempotencyConflictError,
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from './wager-transaction.js';

const at = new Date('2026-10-03T12:00:00.000Z');
const processedAt = new Date('2026-10-03T12:01:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const props = (kind = Kind.Bet): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-a',
  externalTransactionId: 'external-1',
  idempotencyKey: 'provider-a:external-1',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind,
  money: brl('25.00'),
  createdAt: at,
  referenceExternalTransactionId: [Kind.Refund, Kind.Rollback].includes(kind)
    ? 'original-external'
    : undefined,
});
const reference = (
  kind = Kind.Bet,
  overrides: Partial<CreateWagerTransactionProps> = {},
) => {
  const original = WagerTransaction.create({
    ...props(kind),
    id: 'original-id',
    externalTransactionId: 'original-external',
    idempotencyKey: 'provider-a:original-external',
    referenceExternalTransactionId:
      kind === Kind.Refund ? 'earlier-external' : undefined,
    ...overrides,
  });
  original.markProcessed(
    original.referenceExternalTransactionId ? 'earlier-id' : undefined,
    processedAt,
  );
  return original;
};

describe('WagerTransaction', () => {
  // A criação não aplica dinheiro: toda operação externa começa aguardando processamento.
  it.each([Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback])(
    'creates %s as pending',
    (kind) => {
      const tx = WagerTransaction.create(props(kind));
      expect(tx.status).toBe(Status.Pending);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.processedAt).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
    },
  );

  // Impede OPENING na factory usada pelas futuras entradas HTTP e SQS.
  it('rejects external OPENING and permits a separate internal factory', () => {
    expect(() => WagerTransaction.create(props(Kind.Opening))).toThrow(
      InvalidWagerTransactionError,
    );
    const tx = WagerTransaction.createOpening(props(Kind.Opening));
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('requires a positive internal opening amount', () => {
    expect(() =>
      WagerTransaction.createOpening({ ...props(), money: brl('0.00') }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.createOpening({
        ...props(),
        money: brl('1.00').negate(),
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  it.each([Kind.Refund, Kind.Rollback])(
    'requires an external reference for %s',
    (kind) => {
      expect(() =>
        WagerTransaction.create({
          ...props(kind),
          referenceExternalTransactionId: undefined,
        }),
      ).toThrow(InvalidWagerTransactionError);
      expect(() =>
        WagerTransaction.create({
          ...props(kind),
          referenceExternalTransactionId: ' ',
        }),
      ).toThrow(InvalidWagerTransactionError);
      expect(WagerTransaction.create(props(kind)).requiresReference()).toBe(
        true,
      );
    },
  );

  it('supports an optional WIN reference and disallows references on BET and LOSS', () => {
    expect(WagerTransaction.create(props(Kind.Win)).requiresReference()).toBe(
      false,
    );
    expect(
      WagerTransaction.create({
        ...props(Kind.Win),
        referenceExternalTransactionId: 'original-external',
      }).status,
    ).toBe(Status.Pending);
    for (const kind of [Kind.Bet, Kind.Loss]) {
      expect(() =>
        WagerTransaction.create({
          ...props(kind),
          referenceExternalTransactionId: 'original-external',
        }),
      ).toThrow(InvalidWagerTransactionError);
    }
  });

  it.each([
    'id',
    'providerId',
    'externalTransactionId',
    'idempotencyKey',
    'walletId',
    'playerId',
    'roundId',
    'gameId',
  ] as const)('rejects an empty %s', (field) => {
    expect(() => WagerTransaction.create({ ...props(), [field]: '' })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it.each([
    '',
    'abc',
    'A'.repeat(64),
    'a'.repeat(63),
    'g'.repeat(64),
    `${'a'.repeat(64)}\n`,
  ])('rejects invalid payload hashes', (payloadHash) => {
    expect(() => WagerTransaction.create({ ...props(), payloadHash })).toThrow(
      InvalidWagerTransactionError,
    );
  });

  it('rejects invalid kinds, negative amounts, invalid dates and self references', () => {
    expect(() =>
      WagerTransaction.create({ ...props(), kind: 'UNKNOWN' as Kind }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create({ ...props(), money: brl('1.00').negate() }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create({ ...props(), createdAt: new Date('invalid') }),
    ).toThrow(InvalidWagerTransactionError);
    expect(() =>
      WagerTransaction.create({
        ...props(Kind.Refund),
        referenceExternalTransactionId: 'external-1',
      }),
    ).toThrow(InvalidWagerTransactionError);
  });

  // A espera pode repetir por retry; quando a referência chegar, a operação é concluída.
  it('transitions from pending to pending reference and then processed', () => {
    const tx = WagerTransaction.create(props(Kind.Refund));
    tx.markPendingReference();
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    tx.markProcessed('original-id', processedAt);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('original-id');
    expect(tx.processedAt).toEqual(processedAt);
  });

  it('prevents waiting without a reference or processing with an unresolved reference', () => {
    const bet = WagerTransaction.create(props());
    expect(() => bet.markPendingReference()).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => bet.markProcessed('unexpected-id', processedAt)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => bet.markProcessed(undefined, new Date('invalid'))).toThrow(
      InvalidWagerTransactionError,
    );
    const refund = WagerTransaction.create(props(Kind.Refund));
    expect(() => refund.markProcessed(undefined, processedAt)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => refund.markProcessed(refund.id, processedAt)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(refund.status).toBe(Status.Pending);
    expect(refund.processedAt).toBeUndefined();
  });

  // Matriz de regressão: todos os métodos de transição falham após todos os estados terminais.
  it.each([Status.Processed, Status.Rejected, Status.Failed])(
    'cannot leave terminal state %s',
    (status) => {
      const tx = WagerTransaction.rehydrate({
        ...props(),
        status,
        failureCode:
          status === Status.Rejected
            ? FailureCode.InsufficientBalance
            : undefined,
      });
      expect(tx.isTerminal()).toBe(true);
      expect(() => tx.markProcessed(undefined, processedAt)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.markPendingReference()).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.reject(FailureCode.InsufficientBalance)).toThrow(
        InvalidTransactionStateError,
      );
      expect(() => tx.fail(FailureCode.PermanentInfrastructureFailure)).toThrow(
        InvalidTransactionStateError,
      );
      expect(tx.status).toBe(status);
    },
  );

  it.each([Status.Pending, Status.PendingReference])(
    'can reject or fail from %s with an audit code',
    (status) => {
      const rejected = WagerTransaction.rehydrate({
        ...props(Kind.Refund),
        status,
      });
      rejected.reject(FailureCode.ReferenceNotFound);
      expect(rejected.status).toBe(Status.Rejected);
      expect(rejected.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(rejected.affectsBalance()).toBe(false);
      const failed = WagerTransaction.rehydrate({ ...props(), status });
      failed.fail(FailureCode.PermanentInfrastructureFailure);
      expect(failed.status).toBe(Status.Failed);
      expect(failed.failureCode).toBe(
        FailureCode.PermanentInfrastructureFailure,
      );
      expect(failed.affectsBalance()).toBe(false);
    },
  );

  it('rejects unknown failure codes without changing state', () => {
    const tx = WagerTransaction.create(props());
    expect(() => tx.reject('UNKNOWN' as FailureCode)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => tx.fail('UNKNOWN' as FailureCode)).toThrow(
      InvalidWagerTransactionError,
    );
    expect(tx.status).toBe(Status.Pending);
  });

  it('preserves an accepted idempotency key and identifies divergent payloads', () => {
    const tx = WagerTransaction.create({
      ...props(),
      idempotencyKey: 'custom-key',
    });
    expect(tx.idempotencyKey).toBe('custom-key');
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
    expect(() => tx.assertMatchesPayload('b'.repeat(64))).toThrow(
      IdempotencyConflictError,
    );
    expect(() => tx.assertMatchesPayload('a'.repeat(64))).not.toThrow();
  });

  it('selects debit for BET, credit for WIN, and no ledger for LOSS or zero', () => {
    expect(WagerTransaction.create(props()).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
    expect(WagerTransaction.create(props(Kind.Win)).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    const loss = WagerTransaction.create(props(Kind.Loss));
    loss.markProcessed(undefined, processedAt);
    expect(loss.status).toBe(Status.Processed);
    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(
      WagerTransaction.create({
        ...props(),
        money: brl('0.00'),
      }).ledgerDirectionFor(),
    ).toBeUndefined();
  });

  it('credits REFUND of a processed BET', () => {
    expect(
      WagerTransaction.create(props(Kind.Refund)).ledgerDirectionFor(
        reference(),
      ),
    ).toBe(LedgerDirection.Credit);
  });

  // A inversão depende do tipo original: BET retira dinheiro; WIN e REFUND acrescentam.
  it.each([Kind.Bet, Kind.Win, Kind.Refund])(
    'reverses a processed %s',
    (kind) => {
      const tx = WagerTransaction.create(props(Kind.Rollback));
      expect(tx.ledgerDirectionFor(reference(kind))).toBe(
        kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit,
      );
    },
  );

  it('allows a referenced WIN amount different from its BET', () => {
    const win = WagerTransaction.create({
      ...props(Kind.Win),
      money: brl('100.00'),
      referenceExternalTransactionId: 'original-external',
    });
    expect(win.ledgerDirectionFor(reference())).toBe(LedgerDirection.Credit);
  });

  // Valida as fronteiras da referência: uma reversão não pode usar outra wallet ou rodada.
  it.each([
    { overrides: { providerId: 'other' }, code: FailureCode.ProviderMismatch },
    { overrides: { playerId: 'other' }, code: FailureCode.PlayerMismatch },
    { overrides: { walletId: 'other' }, code: FailureCode.WalletMismatch },
    { overrides: { roundId: 'other' }, code: FailureCode.RoundMismatch },
    {
      overrides: { money: Money.from({ amount: '25.00', currency: 'USD' }) },
      code: FailureCode.CurrencyMismatch,
    },
    {
      overrides: { money: brl('24.99') },
      code: FailureCode.ReferenceAmountMismatch,
    },
    {
      overrides: { externalTransactionId: 'other' },
      code: FailureCode.ReferenceNotFound,
    },
  ])('rejects reference mismatch with code $code', ({ overrides, code }) => {
    const tx = WagerTransaction.create(props(Kind.Refund));
    expect(() => tx.validateReference(reference(Kind.Bet, overrides))).toThrow(
      new InvalidTransactionReferenceError(code),
    );
    expect(tx.status).toBe(Status.Pending);
  });

  it('rejects absent, unprocessed and incompatible references', () => {
    const refund = WagerTransaction.create(props(Kind.Refund));
    expect(() => refund.ledgerDirectionFor()).toThrow(
      new InvalidTransactionReferenceError(FailureCode.ReferenceNotFound),
    );
    expect(() => refund.validateReference(reference(Kind.Win))).toThrow(
      new InvalidTransactionReferenceError(FailureCode.InvalidReferenceKind),
    );
    const rollback = WagerTransaction.create(props(Kind.Rollback));
    expect(() => rollback.validateReference(reference(Kind.Loss))).toThrow(
      new InvalidTransactionReferenceError(FailureCode.InvalidReferenceKind),
    );
    const pending = WagerTransaction.create({
      ...props(),
      id: 'original-id',
      externalTransactionId: 'original-external',
    });
    expect(() => refund.validateReference(pending)).toThrow(
      new InvalidTransactionReferenceError(FailureCode.ReferenceNotProcessed),
    );
  });

  it('rehydrates historical state without changing it', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(Kind.Refund),
      status: Status.Processed,
      referenceTransactionId: 'original-id',
      processedAt,
    });
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('original-id');
    expect(tx.processedAt).toEqual(processedAt);
  });

  // readonly sozinho não protege Date; verificamos cópias e identidade em execução.
  it('protects identity and creation/processing dates from external mutation', () => {
    const inputCreatedAt = new Date(at);
    const inputProcessedAt = new Date(processedAt);
    const tx = WagerTransaction.create({
      ...props(),
      createdAt: inputCreatedAt,
    });
    tx.markProcessed(undefined, inputProcessedAt);
    inputCreatedAt.setTime(0);
    inputProcessedAt.setTime(0);
    tx.createdAt.setTime(0);
    tx.processedAt?.setTime(0);
    expect(tx.createdAt).toEqual(at);
    expect(tx.processedAt).toEqual(processedAt);
    expect(Reflect.set(tx, 'kind', Kind.Win)).toBe(false);
    expect(Reflect.set(tx, 'status', Status.Pending)).toBe(false);
  });
});
