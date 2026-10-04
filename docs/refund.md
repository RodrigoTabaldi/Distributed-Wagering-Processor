# REFUND — tarefa 15

REFUND devolve integralmente uma BET processada. Exemplo: BET de 25.00 leva saldo de 100.00 a 75.00; REFUND dessa BET leva o saldo de volta a 100.00.

O endpoint `POST /wagering/transactions` aceita `kind: "REFUND"` com header obrigatório `Idempotency-Key`. A referência à BET também é obrigatória:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "REFUND",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "transaction-123"
}
```

Use IDs existentes e envie uma chave como `provider-a:refund-123`. O valor precisa ser exatamente o da BET; reversão parcial não é aceita.

## Validação e atomicidade

`ProcessRefund` bloqueia a wallet, relê o estado e valida jogador/moeda. Consulta a referência por `(providerId, externalTransactionId)` e usa `WagerTransaction.validateReference()` para exigir BET processada, mesmo provedor, jogador, wallet, moeda, rodada e valor.

Se a referência ainda não chegou ou a BET continua pendente, salva `PENDING_REFERENCE`, HTTP 202, sem crédito. O caso de uso permite retomada depois que a BET terminar; worker agendado, backoff e TTL permanecem na tarefa de referências fora de ordem.

Referência existente inválida gera rejeição auditável com failureCode específico. Uma BET rejeitada não pode ser devolvida. Resolver uma referência de outro provedor como se fosse do atual não é permitido; se o par não existir, permanece pendente.

Para a devolução válida, `Wallet.credit()` cria o novo saldo e um ledger `CREDIT`; a versão aumenta uma vez. Registro do REFUND, saldo, ledger, vínculo interno da BET, estado `PROCESSED` e saldo observado compartilham um único commit. Falhas técnicas causam rollback.

## Uma devolução por BET

Antes de creditar, o repository consulta se já há um REFUND `PROCESSED` da referência. Essa consulta ocorre sob o lock da wallet: toda devolução válida da mesma BET usa a mesma wallet. O índice parcial único `processed_reversal_once`, já existente na migration, protege `(reference_transaction_id, kind)` para reversões processadas no PostgreSQL.

- Reenvio da mesma operação/chave devolve o resultado original com `idempotentReplay: true`, sem novo crédito.
- Outra operação REFUND da mesma BET é `REJECTED / REFERENCE_ALREADY_REFUNDED`, HTTP 422, sem ledger ou mudança na wallet.
- Tentativas rejeitadas ou pendentes não consomem a referência. A proteção não se baseia em memória.

BET de valor zero pode ser devolvida uma vez, sem saldo/versão/ledger novos; ainda consome a unicidade da reversão processada. Devolução que exceda a capacidade monetária é rejeitada com `BALANCE_LIMIT_EXCEEDED`; não consome o direito de outra tentativa válida, mas a tentativa rejeitada em si é terminal e tem replay estável.

Hash e idempotência continuam compartilhados em `SubmitWager`: tipo, valor e referência são campos de negócio. Alterar valor ou referência sob a mesma chave gera 409. Replay preserva o saldo observado original, mesmo depois de novas movimentações.

## Arquivos e verificação

- `src/application/process-refund.ts`: regras e crédito do REFUND, comentados em português.
- `src/application/submit-wager.ts`: inclui REFUND no despacho com idempotência e commit compartilhados.
- `src/application/ports/repositories.ts` e `src/infrastructure/persistence/repositories.ts`: consulta de reversão já processada.
- `src/interfaces/http/submit-wager.dto.ts` e `wager.controller.ts`: referência obrigatória, tipo aceito e erros HTTP.
- `test/integration/refund.spec.ts`: 20 testes com PostgreSQL, incluindo referências inválidas, devolução, 50 duplicatas, dez operações distintas concorrentes e rollback.
- `test/integration/concurrency.spec.ts`: três processos Bun disputam devolver a mesma BET; um processa e dois rejeitam, mantendo um crédito e saldo reconciliado.
- `src/application/submit-wager.spec.ts`: hash inclui REFUND e a referência.

Execute `bun test ./test/integration/refund.spec.ts --timeout 30000` e `bun test ./test/integration/concurrency.spec.ts --timeout 30000`, com PostgreSQL configurado conforme [persistence.md](persistence.md).

As leituras incompatíveis usadas para verificar provider/currency são substituídas somente nesses casos defensivos; persistência e reconciliação final continuam reais. Nenhuma migration nova foi necessária, pois o índice de unicidade e as constraints de referência já existem. Inbox, outbox e eventos continuam nas tarefas previstas.
