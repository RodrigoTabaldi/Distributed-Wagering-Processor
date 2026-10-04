# Failure Codes — tarefa 17

Os provedores interpretam códigos estáveis, sem depender do texto da mensagem. O enum `FailureCode` fica em `src/domain/wager-transaction.ts`, com comentários em português explicando cada valor. As strings abaixo são o contrato público; mudar seu significado ou valor exige revisar os consumidores.

| Código | Significado |
| --- | --- |
| `INSUFFICIENT_BALANCE` | A BET exige mais saldo do que a wallet possui. |
| `REVERSAL_INSUFFICIENT_BALANCE` | ROLLBACK de WIN/REFUND exige retirar um crédito que já foi gasto. |
| `BALANCE_LIMIT_EXCEEDED` | O crédito ultrapassaria a capacidade monetária de NUMERIC(20,2). |
| `REFERENCE_NOT_FOUND` | Referência não encontrada; usado na rejeição terminal após esgotar a espera/tentativas na tarefa 18. |
| `REFERENCE_NOT_PROCESSED` | Origem não está processada; uma origem já rejeitada/falhada não pode justificar a operação dependente. |
| `INVALID_REFERENCE_KIND` | Tipo da origem não permitido, como REFUND de WIN ou ROLLBACK de LOSS. |
| `PROVIDER_MISMATCH` | Provedor da origem é incompatível. |
| `PLAYER_MISMATCH` | Jogador da operação/origem é incompatível. |
| `WALLET_MISMATCH` | Wallet da operação/origem é incompatível. |
| `CURRENCY_MISMATCH` | Moeda incompatível com wallet/origem. |
| `ROUND_MISMATCH` | Origem pertence a outra rodada. |
| `REFERENCE_AMOUNT_MISMATCH` | Valor de REFUND/ROLLBACK difere do valor integral da origem. |
| `REFERENCE_ALREADY_REFUNDED` | Já existe outro REFUND processado para a BET. |
| `REFERENCE_ALREADY_ROLLED_BACK` | Já existe outro ROLLBACK processado para a origem. |
| `IDEMPOTENCY_CONFLICT` | Chave ou identidade externa reutilizada de forma incompatível. |
| `PERMANENT_INFRASTRUCTURE_FAILURE` | Falha técnica declarada permanente; código reservado à finalização como FAILED nas etapas de recuperação. |

## Persistência e resposta

Uma rejeição de negócio chama `WagerTransaction.reject(code)`: estado `REJECTED` e código são persistidos na coluna `wager_transactions.failure_code`, na mesma transação SQL do resultado. Essa rejeição não altera saldo nem produz ledger. HTTP 422 devolve `failureCode`, ID, estado, saldo observado e indicador de replay.

O mapper recupera o código salvo sem executar novamente a regra de negócio. Reenvios devolvem o mesmo código e saldo observado original, mesmo se outra operação já mudou o saldo da wallet. Transações terminais não são reclassificadas.

`IdempotencyConflictError.code` usa `FailureCode.IdempotencyConflict`. O controller devolve HTTP 409 com `code: "IDEMPOTENCY_CONFLICT"`. É um conflito da requisição recebida: não cria uma nova movimentação nem substitui o failureCode da operação original. Não é uma rejeição financeira da operação já registrada.

Vínculos inválidos com a própria wallet são rejeitados como entrada inválida (HTTP 400 com `code`), antes de registrar uma operação. Incompatibilidades com uma referência existente tornam-se rejeições auditáveis (HTTP 422 com `failureCode`). A FK protege jogador/moeda da wallet no banco. A busca por provedor + ID externo evita resolver uma referência de outro provedor como se fosse do atual; se esse par não existe, aguarda a referência.

## Pendência e infraestrutura

Referência ausente ou origem ainda pendente produz `PENDING_REFERENCE`, HTTP 202, sem failureCode e sem movimento. A ausência inicial não deve virar rejeição definitiva, pois as mensagens podem chegar fora de ordem. O worker da tarefa 18 aplica backoff e limite de tentativas/TTL: referência ausente termina com `REFERENCE_NOT_FOUND`; origem ainda pendente termina com `REFERENCE_NOT_PROCESSED`. Veja [pending-references.md](pending-references.md).

Erros técnicos transitórios propagam e causam rollback; a API retorna 503 nos casos reconhecidos. Não são convertidos em `INSUFFICIENT_BALANCE`. A classificação/finalização de falhas permanentes como `FAILED` pertence às etapas de recuperação; nesta tarefa foi verificada somente a persistência do código reservado.

Códigos HTTP de transporte/validação, como `INVALID_PAYLOAD`, `INVALID_MONEY`, `INFRASTRUCTURE_UNAVAILABLE` e `INTERNAL_ERROR`, permanecem nas respostas HTTP; não são failureCodes financeiros gravados sobre uma operação original.

## Verificação

- `src/domain/failure-codes.spec.ts`: protege as strings públicas, distingue os dois códigos de saldo insuficiente e verifica o código do erro de idempotência.
- `test/integration/failure-codes.spec.ts`: PostgreSQL e HTTP reais para rejeição, replay, conflito sem alteração do registro original, pendência sem código prematuro e round-trip dos códigos terminais reservados.
- Os testes de BET, WIN, LOSS, REFUND e ROLLBACK continuam verificando a produção dos códigos em seus cenários de negócio.

Execute `bun run test` e `bun run test:integration`. Os testes dos códigos reservados simulam a decisão terminal pelo domínio; não simulam que worker, TTL ou políticas de retry já estejam implementados. Nenhuma migration nova foi necessária: o schema já exige failureCode em REJECTED/FAILED e proíbe esse campo nos demais estados.
