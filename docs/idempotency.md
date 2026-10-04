# Idempotência persistente — tarefa 12

`POST /wagering/transactions` recebe uma BET e exige o header `Idempotency-Key`. A tarefa 12 iniciou o fluxo com BET; desde a tarefa 13, WIN também é aceito. Desde a tarefa 14, LOSS também é aceito; reversões continuam em suas tarefas. OPENING não é aceito como entrada externa.

```http
POST /wagering/transactions
Content-Type: application/json
Idempotency-Key: provider-a:transaction-123

{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Use IDs de uma wallet existente. O header é obrigatório, não há chave gerada automaticamente. Textos vazios ou com espaços nas extremidades são rejeitados. UUIDs são normalizados para minúsculas; Money valida valor e moeda. Campos adicionais no corpo são rejeitados.

## Hash e identidade

O hash usa SHA-256 sobre JSON UTF-8 sem espaços, com chaves ordenadas recursivamente por comparação lexicográfica de código, independente de locale. O subconjunto contém apenas `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`amount`/`currency`) e `referenceExternalTransactionId`, quando presente. O valor financeiro permanece string com duas casas.

Header, datas, IDs internos e metadados de transporte não entram no hash. Objetos JSON com outra ordem de propriedades geram o mesmo hash. Alterar um campo de negócio gera conflito para a mesma chave.

`idempotency_key` tem unicidade global no PostgreSQL. `(provider_id, external_transaction_id)` também é único. Reenviar esse par sob outra chave é tratado como conflito, mesmo com payload igual: o header é a fonte da verdade. Essa interpretação evita cadastrar uma operação financeira sob múltiplas chaves.

## Atomicidade e concorrência

`SubmitWager` consulta a identidade já salva e, para uma operação nova, bloqueia a wallet. Depois do lock, consulta novamente a identidade. Se continuar ausente, registra a BET e chama `ProcessBet.executeInTransaction` usando a mesma sessão. Registro, saldo, ledger e saldo observado são confirmados em um único commit.

Se a chave disputar wallets diferentes, os locks das wallets não bastam: a constraint UNIQUE arbitra a corrida. A execução perdedora sofre rollback e consulta o vencedor em uma nova transação; uma transação abortada por erro PostgreSQL não é reutilizada. Somente os dois conflitos de identidade conhecidos seguem esse caminho; demais erros propagam.

O replay não executa o débito novamente nem consulta o saldo atual como resultado. Devolve ID, status, saldo observado e failureCode originais, alterando apenas `idempotentReplay` para `true`. Exemplo: após BET de 25.00 o saldo observado é 75.00; se outra BET levar a wallet a 65.00, o replay da primeira continua devolvendo 75.00.

Rejeições por saldo insuficiente também são persistidas e repetidas, sem novo julgamento de saldo. Estado PENDING_REFERENCE é devolvido com HTTP 202 e não gera movimentação. Outros estados não finalizados ou saldo original ausente geram 503, sem inventar resultado.

| HTTP | Significado |
| --- | --- |
| 200 | BET processada ou replay de BET processada |
| 400 | Header, payload, Money ou vínculo de wallet inválido |
| 409 | Conflito de chave/payload ou identidade externa |
| 422 | Rejeição financeira, inclusive seu replay |
| 503 | Infraestrutura transitória ou resultado original indisponível |
| 500 | Falha inesperada com mensagem pública genérica |

Sucesso retorna `transactionId`, `status`, `balance` e `idempotentReplay`. Rejeição inclui também `failureCode`. Não há publicação de eventos nesta etapa; inbox/outbox, autenticação, retries de infraestrutura e métricas seguem suas tarefas.

## Código e testes

- `src/application/submit-wager.ts`: normalização, hash, registro atômico, conflito e replay.
- `src/application/process-bet.ts`: permite reutilizar o processamento na sessão existente, sem abrir um segundo commit.
- `src/application/ports/repositories.ts` e `src/infrastructure/persistence/repositories.ts`: consulta do saldo observado original.
- `src/interfaces/http/submit-wager.dto.ts`, `wager.controller.ts` e `wager.module.ts`: validação de entrada, resposta HTTP e registro no NestJS.
- `src/application/submit-wager.spec.ts`: vetor canônico e alterações de campos de negócio.
- `test/integration/idempotency.spec.ts`: endpoint com PostgreSQL, 50 reenvios, conflitos, rejeição, saldo original e rollback.
- `test/integration/concurrency.spec.ts` e seu helper: 50 envios distribuídos entre três processos Bun, um débito e 49 replays; processo novo encontra o resultado persistido.

Execute `bun run test` e `bun run test:integration` com PostgreSQL configurado conforme [persistence.md](persistence.md). O teste de novo processo demonstra persistência do replay; crash entre commit e ack SQS pertence à etapa de mensageria.


Atualização da tarefa 13: o fluxo agora atende BET e WIN. A referência opcional entra no hash e o estado PENDING_REFERENCE é devolvido com HTTP 202. Consulte [win.md](win.md).


Atualização da tarefa 14: LOSS reutiliza a idempotência sem movimentar saldo. Consulte [loss.md](loss.md).


Atualização da tarefa 15: REFUND reutiliza a idempotência e exige referência à BET. A unicidade por referência é distinta do replay por chave; consulte [refund.md](refund.md).


Atualização da tarefa 16: ROLLBACK também usa o mesmo contrato de idempotência, com referência obrigatória. Consulte [rollback.md](rollback.md).
