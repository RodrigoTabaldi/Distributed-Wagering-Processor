import { Money } from './money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

// Tipo da operação. OPENING existe apenas para registrar o saldo inicial internamente.
export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

// Estados terminais não podem mudar, mesmo quando a mensagem chegar novamente.
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

// Códigos estáveis permitem interpretar uma falha sem depender do texto da mensagem.
// A aplicação usará esses códigos ao processar saldo, referências e infraestrutura.
export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalInsufficientBalance = 'REVERSAL_INSUFFICIENT_BALANCE',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ProviderMismatch = 'PROVIDER_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  WalletMismatch = 'WALLET_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  RoundMismatch = 'ROUND_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyRefunded = 'REFERENCE_ALREADY_REFUNDED',
  ReferenceAlreadyRolledBack = 'REFERENCE_ALREADY_ROLLED_BACK',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

// Dados de negócio já convertidos para Money, não são um DTO HTTP ou SQS.
export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

// A persistência fornecerá também os campos de estado ao reconstruir uma operação.
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus) {
    super(`Cannot transition a terminal transaction: ${status}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidTransactionReferenceError extends Error {
  constructor(public readonly code: FailureCode) {
    super(`Invalid transaction reference: ${code}`);
    this.name = 'InvalidTransactionReferenceError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was reused with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

// Guarda a operação e controla seu ciclo de vida; não altera saldo nem acessa o banco.
export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId?: string;
  readonly #createdAt: Date;
  #status: WagerTransactionStatus;
  #referenceTransactionId?: string;
  #failureCode?: FailureCode;
  #processedAt?: Date;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    // Copiar datas impede que alterações externas modifiquem o histórico.
    this.#createdAt = new Date(state.createdAt.getTime());
    this.#status = state.status;
    this.#referenceTransactionId = state.referenceTransactionId;
    this.#failureCode = state.failureCode;
    this.#processedAt = state.processedAt
      ? new Date(state.processedAt.getTime())
      : undefined;
    Object.freeze(this);
  }

  // Entrada externa: a futura API e o consumer deverão usar esta factory.
  // OPENING é rejeitado aqui para não aceitar créditos de abertura enviados por provedores.
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('OPENING is internal only');
    }
    return WagerTransaction.createPending(props);
  }

  // Factory exclusiva do fluxo interno de criação de wallet; não será exposta nos adapters.
  static createOpening(
    props: Omit<
      CreateWagerTransactionProps,
      'kind' | 'referenceExternalTransactionId'
    >,
  ): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING amount must be positive');
    }
    return WagerTransaction.createPending({
      ...props,
      kind: WagerTransactionKind.Opening,
    });
  }

  // Reconstrói o estado salvo sem repetir validações de transição nem movimentações.
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this.#status;
  }
  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this.#failureCode;
  }
  get createdAt(): Date {
    return new Date(this.#createdAt.getTime());
  }
  get processedAt(): Date | undefined {
    return this.#processedAt
      ? new Date(this.#processedAt.getTime())
      : undefined;
  }

  // Só marcar após validar/aplicar a operação; a aplicação persistirá tudo no mesmo commit.
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    if (!Number.isFinite(at.getTime())) {
      throw new InvalidWagerTransactionError('Invalid processing date');
    }
    if (this.referenceExternalTransactionId !== undefined) {
      WagerTransaction.assertIdentifier(
        referenceTransactionId,
        'referenceTransactionId',
      );
      if (referenceTransactionId === this.id) {
        throw new InvalidWagerTransactionError(
          'A transaction cannot reference itself',
        );
      }
    } else if (referenceTransactionId !== undefined) {
      throw new InvalidWagerTransactionError('Unexpected internal reference');
    }
    this.#referenceTransactionId = referenceTransactionId;
    this.#processedAt = new Date(at.getTime());
    this.#status = WagerTransactionStatus.Processed;
  }

  // O worker poderá tentar novamente quando a operação referenciada chegar.
  markPendingReference(): void {
    this.assertNotTerminal();
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        'Pending reference requires an external reference',
      );
    }
    this.#status = WagerTransactionStatus.PendingReference;
  }

  // Rejeição de negócio é terminal e auditável, não representa movimentação financeira.
  reject(code: FailureCode): void {
    this.assertNotTerminal();
    WagerTransaction.assertFailureCode(code);
    this.#failureCode = code;
    this.#status = WagerTransactionStatus.Rejected;
  }

  // Erro permanente de infraestrutura é terminal, erros transitórios serão tratados por retry.
  fail(code: FailureCode): void {
    this.assertNotTerminal();
    WagerTransaction.assertFailureCode(code);
    this.#failureCode = code;
    this.#status = WagerTransactionStatus.Failed;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this.#status);
  }

  // LOSS, valor zero e operações rejeitadas/falhadas não devem produzir ledger.
  affectsBalance(): boolean {
    return (
      this.kind !== WagerTransactionKind.Loss &&
      !this.money.isZero() &&
      this.#status !== WagerTransactionStatus.Rejected &&
      this.#status !== WagerTransactionStatus.Failed
    );
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  // O hash será calculado pela aplicação; aqui apenas comparamos o valor armazenado.
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  assertMatchesPayload(payloadHash: string): void {
    if (!this.matchesPayload(payloadHash)) throw new IdempotencyConflictError();
  }

  // Valida a referência já encontrada pela aplicação, sem executar consultas no domínio.
  validateReference(reference: WagerTransaction): void {
    const reject = (code: FailureCode): never => {
      throw new InvalidTransactionReferenceError(code);
    };
    if (
      reference.id === this.id ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    )
      reject(FailureCode.ReferenceNotFound);
    if (reference.providerId !== this.providerId)
      reject(FailureCode.ProviderMismatch);
    if (reference.playerId !== this.playerId)
      reject(FailureCode.PlayerMismatch);
    if (reference.walletId !== this.walletId)
      reject(FailureCode.WalletMismatch);
    if (reference.money.currency !== this.money.currency)
      reject(FailureCode.CurrencyMismatch);
    if (reference.roundId !== this.roundId) reject(FailureCode.RoundMismatch);
    const permittedKinds =
      this.kind === WagerTransactionKind.Rollback
        ? [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ]
        : [WagerTransactionKind.Bet];
    if (!permittedKinds.includes(reference.kind))
      reject(FailureCode.InvalidReferenceKind);
    if (reference.status !== WagerTransactionStatus.Processed)
      reject(FailureCode.ReferenceNotProcessed);
    if (this.requiresReference() && !this.money.equals(reference.money))
      reject(FailureCode.ReferenceAmountMismatch);
  }

  // undefined significa ausência de lançamento. ROLLBACK inverte a direção original.
  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection | undefined {
    if (!this.affectsBalance()) return undefined;
    if (this.referenceExternalTransactionId !== undefined) {
      if (!reference)
        throw new InvalidTransactionReferenceError(
          FailureCode.ReferenceNotFound,
        );
      this.validateReference(reference);
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      return reference?.kind === WagerTransactionKind.Bet
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }

  private static createPending(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    for (const field of [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      WagerTransaction.assertIdentifier(props[field], field);
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind))
      throw new InvalidWagerTransactionError('Invalid transaction kind');
    if (
      typeof props.payloadHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(props.payloadHash) ||
      props.payloadHash.trim() !== props.payloadHash
    ) {
      throw new InvalidWagerTransactionError(
        'Payload hash must be a lowercase SHA-256 hex digest',
      );
    }
    if (!Number.isFinite(props.createdAt.getTime()))
      throw new InvalidWagerTransactionError('Invalid creation date');
    if (props.money.isNegative())
      throw new InvalidWagerTransactionError(
        'Transaction amount must not be negative',
      );
    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;
    if (
      requiresReference ||
      props.referenceExternalTransactionId !== undefined
    ) {
      WagerTransaction.assertIdentifier(
        props.referenceExternalTransactionId,
        'referenceExternalTransactionId',
      );
      if (
        ![
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
          WagerTransactionKind.Rollback,
        ].includes(props.kind)
      )
        throw new InvalidWagerTransactionError(
          'Reference is not supported for this kind',
        );
      if (props.referenceExternalTransactionId === props.externalTransactionId)
        throw new InvalidWagerTransactionError(
          'A transaction cannot reference itself',
        );
    }
    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
    });
  }

  private static assertIdentifier(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new InvalidWagerTransactionError(`${field} must not be empty`);
  }

  private static assertFailureCode(code: FailureCode): void {
    if (!Object.values(FailureCode).includes(code))
      throw new InvalidWagerTransactionError('Invalid failure code');
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.#status);
  }
}
