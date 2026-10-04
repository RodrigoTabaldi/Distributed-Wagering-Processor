# Códigos de falha

Os provedores interpretam códigos estáveis, sem depender do texto da mensagem. O enum FailureCode fica em src/domain/wager-transaction.ts. Mudar o significado de um código exige revisar os consumidores.

| Código | Significado |
| --- | --- |
| INSUFFICIENT_BALANCE | A BET exige mais saldo do que a wallet possui. |
| REVERSAL_INSUFFICIENT_BALANCE | ROLLBACK de WIN/REFUND exige retirar um crédito que já foi gasto. |
| BALANCE_LIMIT_EXCEEDED | O crédito ultrapassaria a capacidade de NUMERIC(20,2). |
| REFERENCE_NOT_FOUND | Referência não chegou antes de esgotar tentativas ou TTL. |
| REFERENCE_NOT_PROCESSED | A origem não está processada e não pode justificar a operação dependente. |
| INVALID_REFERENCE_KIND | Tipo da origem não permitido, como REFUND de WIN. |
| PROVIDER_MISMATCH | Provedor da origem incompatível. |
| PLAYER_MISMATCH | Jogador da operação/origem incompatível. |
| WALLET_MISMATCH | Wallet da operação/origem incompatível. |
| CURRENCY_MISMATCH | Moeda incompatível com wallet/origem. |
| ROUND_MISMATCH | Origem pertence a outra rodada. |
| REFERENCE_AMOUNT_MISMATCH | Reversão difere do valor integral da origem. |
| REFERENCE_ALREADY_REFUNDED | Outro REFUND já foi processado para a BET. |
| REFERENCE_ALREADY_ROLLED_BACK | Outro ROLLBACK já foi processado para a origem. |
| IDEMPOTENCY_CONFLICT | Chave ou identidade externa reutilizada de forma incompatível. |
| PERMANENT_INFRASTRUCTURE_FAILURE | Falha técnica permanente persistida como FAILED, sem movimento financeiro. |

## Persistência e resposta

Rejeição de negócio chama reject(code): estado REJECTED, código, saldo observado e evento são persistidos na mesma transação SQL. Não altera saldo nem produz ledger. HTTP 422 devolve o resultado. Replay mantém o código e saldo originais mesmo depois de outras movimentações.

Conflito de idempotência retorna HTTP 409 sem substituir a operação original. Vínculos inválidos com a própria wallet retornam HTTP 400 antes de registrar uma operação; incompatibilidades com uma referência existente tornam-se rejeições auditáveis com HTTP 422. A FK protege jogador/moeda da wallet. Referências são resolvidas por provedor e ID externo.

## Pendência e infraestrutura

Referência ausente ou ainda pendente produz PENDING_REFERENCE e HTTP 202, sem código de falha nem movimento. O worker usa backoff, 20 tentativas ou TTL de 30 minutos. Esgotamento termina com REFERENCE_NOT_FOUND ou REFERENCE_NOT_PROCESSED. Veja [pending-references.md](pending-references.md).

Falhas transitórias causam rollback e HTTP 503 nos casos reconhecidos. Falhas explicitamente permanentes (PermanentInfrastructureError) ou de schema (PostgreSQL 42P01, 42703, 42883) também desfazem a tentativa financeira. Depois, uma nova transação sob lock da wallet grava FAILED, saldo observado e WagerTransactionFailed. No SQS, a Inbox participa desse commit, antes de enviar à DLQ e confirmar ACK.

Se a auditoria não puder confirmar, a origem permanece recuperável. Um resultado terminal concorrente nunca é substituído por FAILED. HTTP 502 devolve o resultado técnico terminal; replay mantém estado e saldo originais. Corrigir a infraestrutura não reabre automaticamente uma operação FAILED.

Cinco recebimentos com falha transitória levam a mensagem à DLQ para diagnóstico e redrive. Isso não prova permanência: o banco pode voltar e a operação ainda ser válida. Mensagens malformadas também vão à DLQ sem inventar uma transação financeira. Após corrigir a causa, use a mesma identidade; resultados terminais continuam terminais.

## Verificação

- src/application/errors.spec.ts: diferencia erros transitórios, desconhecidos e permanentes.
- test/integration/idempotency.spec.ts: falha permanente, replay HTTP 502, conflito 409 e preservação de sucesso concorrente.
- test/integration/messaging.spec.ts: rollback do débito, FAILED/Inbox/Outbox atômicos, falha de envio à DLQ, redelivery e falha na auditoria.
- As suites de operações e referências verificam rejeições de negócio e esgotamento de referências.

Execute bun run test e bun run test:integration. O schema existente exige código em REJECTED/FAILED e proíbe alteração de estados terminais; nenhuma nova migration foi necessária.