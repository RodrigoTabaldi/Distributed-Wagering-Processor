# Concorrência por wallet — tarefa 11

A estratégia é pessimistic locking por `walletId` no PostgreSQL. `PostgreSqlWalletRepository.findByIdForUpdate()` usa `LockMode.PESSIMISTIC_WRITE`, que executa `SELECT FOR UPDATE`. O lock dura até terminar a transação SQL do `PostgreSqlUnitOfWork`.

`ProcessBet` obtém esse lock antes de consultar o saldo para debitar e relê o estado da BET depois de obtê-lo. O repository também condiciona a atualização à versão anterior da wallet. Nenhum mutex, cache ou lock global em memória é usado como garantia financeira.

Se duas apostas de `80.00` disputarem `100.00`, uma execução obtém o lock e confirma o débito. A outra espera e, ao continuar, recebe o saldo atualizado de `20.00`; por isso registra `REJECTED / INSUFFICIENT_BALANCE`, sem débito. Os locks pertencem às linhas de cada wallet: não serializam o processamento de wallets distintas.

O custo é que uma wallet muito disputada tem operações serializadas e pode acumular espera. Mantenha a transação curta e não faça chamadas externas enquanto segura o lock. Falhas transitórias continuam causando rollback; políticas de retry e métricas pertencem às tarefas correspondentes.

## Evidência reproduzível

Com PostgreSQL e `dwp_test` configurados, execute:

```powershell
bun test ./test/integration/concurrency.spec.ts --timeout 30000
```

Os testes iniciam três processos Bun, cada um com MikroORM e uma conexão PostgreSQL própria. `test/helpers/concurrency-worker.ts` é um executor exclusivo de testes, não uma nova aplicação ou endpoint.

- Duas BETs de `80.00` disputam a mesma wallet: uma `PROCESSED`, outra `REJECTED`, saldo final `20.00`, versão 2 e exatamente um ledger `DEBIT`.
- Uma barreira pausa o primeiro processo após adquirir o lock real. O teste consulta `pg_blocking_pids` para confirmar que o segundo está bloqueado. Enquanto isso, o terceiro confirma uma BET em outra wallet, demonstrando ausência de lock global.
- Reexecutar os IDs terminais gera `InvalidTransactionStateError` e não duplica o débito. A resposta de replay com resultado original permanece na tarefa 12.
- Três processos com apostas distintas de `10.00`, `20.00` e `30.00` na mesma wallet terminam com saldo `40.00`, versão 4 e três débitos, sem lost update (uma gravação sobrescrever outra).
- Cada saldo final é comparado com a soma dos créditos menos os débitos do ledger usando `NUMERIC` no banco.

A barreira controla o momento da execução, mas não substitui repositories nem PostgreSQL por mocks. O polling verifica a condição real do banco; o timeout apenas limita falhas. Todos os processos criados pelo teste são encerrados ao final, inclusive em caso de erro.

Os testes validam concorrência no caso de uso financeiro entre processos. Não verificam ainda HTTP/SQS, ack, inbox/outbox, ou replays por chave de idempotência. A métrica de conflitos/espera de lock está planejada para a etapa de observabilidade e não foi implementada nesta tarefa.
