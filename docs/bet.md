# Processamento de BET — tarefa 10

`src/application/process-bet.ts` implementa `ProcessBet.execute(transactionId)`. Recebe o ID de uma BET já persistida como `PENDING` e devolve o resultado somente após o commit.

Exemplo: uma wallet com `100.00 BRL` recebe uma BET de `25.00 BRL`. O resultado é `PROCESSED`, saldo `75.00`, versão incrementada de 1 para 2 e um único lançamento `DEBIT` de `25.00`, com saldo anterior e posterior registrados.

## Garantias

1. A aplicação abre uma transação SQL e encontra a BET.
2. Bloqueia a wallet com `SELECT FOR UPDATE`, usando o repository existente. O bloqueio é por wallet e dura até commit/rollback.
3. Relê a transação após obter o bloqueio, evitando usar um estado `PENDING` desatualizado.
4. Valida estado, wallet, jogador e moeda antes de chamar `Wallet.debit()`.
5. Salva saldo, versão, ledger e estado `PROCESSED` na mesma transação SQL, guardando também o saldo observado no resultado.

Saldo insuficiente produz `REJECTED` e `failureCode: INSUFFICIENT_BALANCE`. A wallet, sua versão e sua data de atualização permanecem iguais e não há ledger dessa BET. Gastar exatamente o saldo é permitido.

Falhas técnicas propagam o erro e causam rollback. Não são convertidas em rejeição de saldo. Depois do rollback, a BET continua `PENDING` e pode ser tentada novamente.

## Decisões de escopo

- Valor zero segue o domínio existente: é `PROCESSED`, sem alteração de saldo/versão e sem ledger.
- Wallet ausente, vínculos incompatíveis e operação de outro tipo geram `InvalidBetError` antes das gravações. As FKs do PostgreSQL também impedem persistir transações com jogador/moeda incompatíveis. Esses casos representam uma entrada inválida ou inconsistência, distinta da rejeição auditável por saldo insuficiente.
- Transação terminal não é executada novamente; gera `InvalidTransactionStateError`. A tarefa de idempotência deverá devolver o resultado original salvo, sem chamar este processamento outra vez.
- Este caso de uso ainda não é um endpoint nem um consumer SQS. Os adapters e o fluxo compartilhado serão conectados nas tarefas correspondentes; não foi adicionada uma rota antecipadamente.
- Inbox e outbox permanecem nas tarefas previstas. Esta etapa garante atomicidade entre saldo, ledger e estado da BET.

## Verificação

`test/integration/process-bet.spec.ts` usa PostgreSQL real para débito, rejeição, centavos, versão, ledger, rollback e execução repetida/concorrente do mesmo ID. Para vínculos incompatíveis, substitui somente a leitura do repository, pois o banco impede armazenar esses dados inválidos.

Execute `bun test ./test/integration/process-bet.spec.ts --timeout 30000`, com o banco `dwp_test` configurado conforme [persistence.md](persistence.md).

A tarefa 11 ainda deve verificar seu cenário próprio de apostas distintas concorrentes e múltiplas instâncias; o teste concorrente desta etapa usa duas execuções do mesmo ID no mesmo processo.


Desde a tarefa 12, SubmitWager conecta este processamento ao endpoint POST /wagering/transactions e controla o replay antes de chamar ProcessBet. A API e a persistência do resultado estão descritas em [idempotency.md](idempotency.md).


Atualização da tarefa 13: o fluxo agora atende BET e WIN. A referência opcional entra no hash e o estado PENDING_REFERENCE é devolvido com HTTP 202. Consulte [win.md](win.md).
