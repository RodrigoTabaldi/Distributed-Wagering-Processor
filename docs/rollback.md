# ROLLBACK — tarefa 16

ROLLBACK é uma nova operação auditável que desfaz uma operação financeira anterior. Não apaga ou altera seu ledger. Isso difere do rollback SQL: o rollback SQL cancela as gravações de uma execução que falhou; o ROLLBACK de negócio cria uma movimentação inversa que será confirmada em outro commit.

`POST /wagering/transactions` aceita `kind: "ROLLBACK"`, header obrigatório `Idempotency-Key` e referência obrigatória:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "rollback-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "ROLLBACK",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "transaction-123"
}
```

Use IDs existentes e uma chave como `provider-a:rollback-123`. O valor precisa ser igual ao da operação referenciada; reversão parcial não é aceita.

| Origem processada | Efeito do ROLLBACK | Ledger |
| --- | --- | --- |
| BET | Devolve o valor descontado | CREDIT |
| WIN | Retira o prêmio creditado | DEBIT |
| REFUND | Retira o valor devolvido | DEBIT |

## Validação e proteção financeira

`ProcessRollback` bloqueia a wallet e relê o estado. A referência é buscada por provedor + ID externo. O domínio exige origem `PROCESSED`, tipo permitido, mesmo provedor, jogador, wallet, moeda, rodada e valor. LOSS, OPENING e ROLLBACK não são origens permitidas.

`WagerTransaction.ledgerDirectionFor(reference)` determina a direção inversa. A Wallet aplica o crédito ou débito usando Money, cria o ledger e incrementa a versão. Registro, alteração de saldo, ledger, vínculo da origem, estado final e saldo observado para replay compartilham um commit. A operação original permanece intacta.

Se desfazer WIN/REFUND deixaria saldo negativo, a operação fica `REJECTED / REVERSAL_INSUFFICIENT_BALANCE`, HTTP 422. Esse código difere de `INSUFFICIENT_BALANCE` da BET. Wallet, versão e ledger permanecem iguais. Uma rejeição é terminal e tem replay estável; outra tentativa válida pode ter nova identidade.

Crédito acima da capacidade monetária fica `REJECTED / BALANCE_LIMIT_EXCEEDED`. Origem de valor zero pode ser revertida uma vez, sem alterar saldo/versão ou produzir ledger, mas os vínculos são validados e a reversão consome a unicidade processada.

## Unicidade e referências pendentes

A consulta de reversão anterior ocorre sob o lock da wallet. O índice parcial único `processed_reversal_once`, já existente, garante uma reversão processada por `(reference_transaction_id, kind)`. Outro ROLLBACK da mesma origem é rejeitado com `REFERENCE_ALREADY_ROLLED_BACK`.

A unicidade é por tipo de operação, conforme o desafio: REFUND e ROLLBACK têm controles separados. Não foi introduzida uma proibição adicional de tipos diferentes sobre a mesma referência.

Reenviar a mesma chave/payload recebe o resultado original, sem movimentar novamente. Alterar referência, valor ou tipo sob essa chave retorna 409. O hash inclui o tipo ROLLBACK e a referência.

Referência ausente ou ainda pendente produz `PENDING_REFERENCE`, HTTP 202, sem movimentação. `ProcessRollback.execute(id)` permite retomar após a chegada/conclusão da origem. Worker agendado, backoff e TTL permanecem na tarefa 18.

## Arquivos e evidências

- `src/application/process-rollback.ts`: regras, inversão e rejeições, comentadas em português.
- `src/application/submit-wager.ts`: despacho de ROLLBACK usando idempotência e sessão existentes.
- `src/interfaces/http/submit-wager.dto.ts` e `wager.controller.ts`: tipo aceito, referência obrigatória e validação HTTP.
- `test/integration/rollback.spec.ts`: 27 testes com PostgreSQL, incluindo BET/WIN/REFUND, saldo insuficiente, valor zero, limite monetário, pendência, replay, 50 duplicatas, operações distintas concorrentes e rollback de falhas.
- `test/integration/concurrency.spec.ts`: três processos Bun disputando desfazer o mesmo WIN; um débito, duas rejeições, saldo final zero e reconciliação exata com o ledger.
- `src/application/submit-wager.spec.ts`: tipo e referência participam da identidade do payload.

Execute `bun test ./test/integration/rollback.spec.ts --timeout 30000` e `bun test ./test/integration/concurrency.spec.ts --timeout 30000`, com PostgreSQL configurado conforme [persistence.md](persistence.md). Somente as leituras incompatíveis dos testes defensivos de provider/currency são substituídas; os efeitos finais e a reconciliação usam PostgreSQL real.

Não foi necessária nova migration. Inbox, outbox e eventos permanecem nas tarefas previstas.
