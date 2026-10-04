// Contrato público sem autenticação nesta demonstração. A implementação dos DTOs continua validando a entrada.
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const uuid = { type: 'string', format: 'uuid' };
const text = { type: 'string', minLength: 1, maxLength: 255 };
const money = ref('Money');
const response = (description: string, schema?: object) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});
const failure = {
  '400': response('Payload, valor, UUID ou cursor inválido'),
  '404': response('Recurso não encontrado'),
  '500': response('Falha inesperada; código INTERNAL_ERROR'),
  '503': response(
    'Infraestrutura temporariamente indisponível; código INFRASTRUCTURE_UNAVAILABLE',
  ),
};
const pathId = (name: string) => ({
  name,
  in: 'path',
  required: true,
  schema:
    name.endsWith('Id') &&
    !['providerId', 'externalTransactionId'].includes(name)
      ? uuid
      : text,
});
const read = (summary: string, schema: object, parameters: object[]) => ({
  summary,
  parameters,
  responses: { '200': response('Consulta realizada', schema), ...failure },
});
const body = (schema: object) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const object = (
  properties: Record<string, object>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required, additionalProperties: false });

export const openApi = {
  openapi: '3.0.3',
  info: {
    title: 'Digital Wallet Platform',
    version: '1.0.0',
    description:
      'Demonstração técnica. Dinheiro usa strings decimais; Idempotency-Key é obrigatória no envio de transações. Autenticação não está implementada.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/wallets': {
      post: {
        summary:
          'Abrir wallet; saldo positivo gera OPENING e ledger atomicamente',
        requestBody: body(ref('CreateWallet')),
        responses: {
          '201': response('Wallet criada', ref('CreatedWallet')),
          '409': response('Já existe wallet para player/moeda'),
          ...failure,
        },
      },
    },
    '/wallets/{walletId}': {
      get: read('Consultar saldo e versão', ref('Wallet'), [
        pathId('walletId'),
      ]),
    },
    '/wallets/{walletId}/ledger': {
      get: read(
        'Ledger por cursor estável; não permite editar ou excluir',
        ref('LedgerPage'),
        [
          pathId('walletId'),
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
          {
            name: 'cursor',
            in: 'query',
            schema: { type: 'string', maxLength: 512 },
          },
        ],
      ),
    },
    '/wallets/{walletId}/reconciliation': {
      post: read(
        'Comparar saldo com soma exata do ledger, sem corrigir dados',
        ref('Reconciliation'),
        [pathId('walletId')],
      ),
    },
    '/wagering/transactions': {
      post: {
        summary:
          'BET, WIN, LOSS, REFUND ou ROLLBACK com idempotência persistente',
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: text,
          },
          {
            name: 'X-Correlation-Id',
            in: 'header',
            schema: { type: 'string', pattern: '^[a-zA-Z0-9:_-]{1,128}$' },
          },
        ],
        requestBody: body(ref('SubmitWager')),
        responses: {
          '200': response(
            'Processada ou replay do resultado persistido',
            ref('WagerResult'),
          ),
          '202': response(
            'Referência pendente; nenhum efeito financeiro antecipado',
            ref('WagerResult'),
          ),
          '409': response('Chave/identidade reutilizada com payload diferente'),
          '422': response('Rejeição financeira persistida', ref('WagerResult')),
          '502': response(
            'Falha técnica terminal persistida; não repetir a operação',
            ref('WagerResult'),
          ),
          ...failure,
        },
      },
    },
    '/wagering/transactions/{transactionId}': {
      get: read('Consultar transação interna', ref('Transaction'), [
        pathId('transactionId'),
      ]),
    },
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}': {
      get: read(
        'Consultar transação pela identidade externa',
        ref('Transaction'),
        [pathId('providerId'), pathId('externalTransactionId')],
      ),
    },
    '/health/live': {
      get: {
        summary: 'Liveness pública; processo responde',
        responses: { '200': response('Processo vivo') },
      },
    },
    '/health/ready': {
      get: {
        summary: 'Readiness pública; PostgreSQL e três filas SQS acessíveis',
        responses: {
          '200': response('Pronto'),
          '503': response('Dependência indisponível'),
        },
      },
    },
    '/metrics': {
      get: {
        summary: 'Métricas Prometheus; sem labels monetários ou IDs',
        responses: {
          '200': {
            description: 'Métricas',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          '500': failure['500'],
          '503': failure['503'],
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'Este documento OpenAPI',
        responses: { '200': response('Contrato OpenAPI') },
      },
    },
  },
  components: {
    schemas: {
      Money: object({
        amount: {
          type: 'string',
          pattern: '^[0-9]{1,18}\\.[0-9]{2}$',
          example: '100.00',
          description:
            'Exatamente duas casas; até NUMERIC(20,2). Zero é válido, sinais/expoentes/números JSON são rejeitados.',
        },
        currency: {
          type: 'string',
          pattern: '^[A-Z]{3}$',
          example: 'BRL',
          description:
            'Código ISO reconhecido pelo runtime; wallets operam em uma única moeda.',
        },
      }),
      SignedMoney: object({
        amount: { type: 'string', pattern: '^-?[0-9]{1,18}\\.[0-9]{2}$' },
        currency: { type: 'string' },
      }),
      CreateWallet: object({ playerId: uuid, initialBalance: money }),
      CreatedWallet: object({
        id: uuid,
        playerId: uuid,
        balance: money,
        version: { type: 'integer' },
      }),
      Wallet: object({
        walletId: uuid,
        playerId: uuid,
        balance: money,
        version: { type: 'integer' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      }),
      SubmitWager: {
        // oneOf expressa quando a referência é obrigatória, opcional ou proibida.
        oneOf: [
          object({
            providerId: text,
            externalTransactionId: text,
            playerId: uuid,
            walletId: uuid,
            roundId: text,
            gameId: text,
            kind: { type: 'string', enum: ['BET', 'LOSS'] },
            money,
          }),
          object(
            {
              providerId: text,
              externalTransactionId: text,
              playerId: uuid,
              walletId: uuid,
              roundId: text,
              gameId: text,
              kind: { type: 'string', enum: ['WIN'] },
              money,
              referenceExternalTransactionId: text,
            },
            [
              'providerId',
              'externalTransactionId',
              'playerId',
              'walletId',
              'roundId',
              'gameId',
              'kind',
              'money',
            ],
          ),
          object({
            providerId: text,
            externalTransactionId: text,
            playerId: uuid,
            walletId: uuid,
            roundId: text,
            gameId: text,
            kind: { type: 'string', enum: ['REFUND', 'ROLLBACK'] },
            money,
            referenceExternalTransactionId: text,
          }),
        ],
      },
      WagerResult: object(
        {
          transactionId: uuid,
          status: {
            type: 'string',
            enum: ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED'],
          },
          balance: money,
          failureCode: { type: 'string' },
          idempotentReplay: { type: 'boolean' },
        },
        ['transactionId', 'status', 'balance', 'idempotentReplay'],
      ),
      Transaction: object({
        transactionId: uuid,
        providerId: text,
        externalTransactionId: text,
        walletId: uuid,
        playerId: uuid,
        roundId: text,
        gameId: text,
        kind: {
          type: 'string',
          enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'],
        },
        money,
        status: {
          type: 'string',
          enum: [
            'PENDING',
            'PENDING_REFERENCE',
            'PROCESSED',
            'REJECTED',
            'FAILED',
          ],
        },
        referenceExternalTransactionId: { type: 'string', nullable: true },
        referenceTransactionId: { ...uuid, nullable: true },
        failureCode: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        processedAt: { type: 'string', format: 'date-time', nullable: true },
      }),
      LedgerPage: object({
        walletId: uuid,
        entries: {
          type: 'array',
          items: object({
            id: uuid,
            walletId: uuid,
            transactionId: uuid,
            direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
            money,
            balanceBefore: money,
            balanceAfter: money,
            createdAt: { type: 'string', format: 'date-time' },
          }),
        },
        nextCursor: { type: 'string', nullable: true },
      }),
      Reconciliation: object({
        walletId: uuid,
        storedBalance: money,
        calculatedBalance: ref('SignedMoney'),
        checkedEntries: { type: 'integer' },
        difference: ref('SignedMoney'),
        consistent: { type: 'boolean' },
      }),
    },
  },
};
