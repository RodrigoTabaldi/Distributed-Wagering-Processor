# Referências fora de ordem — tarefa 18

REFUND, ROLLBACK e WIN com referência podem chegar antes de sua origem. A API mantém `PENDING_REFERENCE` (HTTP 202), sem failureCode, movimento ou ledger. Reenvios com a mesma chave não reiniciam a agenda.

O `PendingReferenceWorker`, registrado no AppModule, consulta a agenda no PostgreSQL a cada segundo. `ReprocessPendingReferences` retoma os mesmos ProcessWin/ProcessRefund/ProcessRollback, com o ID, hash e chave originais. A referência é procurada por provedor + ID externo. Ao chegar uma origem válida e processada, a operação é processada na próxima tentativa vencida.

## Política e justificativa

- Primeira tentativa: após 1 segundo.
- Espera após tentativas sem referência: 2, 4, 8, 16, 32 e depois 60 segundos.
- Limite: 20 tentativas concluídas ou TTL de 30 minutos desde a criação.
- Lotes: até 25 operações vencidas, ordenadas por agenda e ID.

A primeira espera curta atende referências que chegam logo depois; aumentar e limitar a espera evita consultas excessivas. Vinte tentativas cobrem aproximadamente 15 minutos em condições normais; o TTL limita a espera se houver atrasos ou reinícios. Esses valores são uma decisão explícita para o desafio, não uma garantia de prazo sob indisponibilidade do banco. Não foram adicionadas dependências de agendamento.

A última tentativa, inclusive após TTL, ainda pode processar a origem que chegou. Se ela continuar ausente, termina em `REJECTED / REFERENCE_NOT_FOUND`; se existir mas permanecer pendente, em `REJECTED / REFERENCE_NOT_PROCESSED`. Referências inválidas ou já rejeitadas usam a rejeição normal do processador. A rejeição não movimenta dinheiro e permanece disponível no replay.

## Persistência e concorrência

`Migration202610030002` adiciona `reference_attempts`, `reference_next_attempt_at` e índice parcial de pendências. Registros antigos são agendados ao aplicar a migration. O trigger continua bloqueando alteração de payload e de estados terminais; apenas os metadados da agenda podem mudar enquanto pendente. A reversão desta migration preserva os registros financeiros, removendo somente a agenda.

Cada tentativa bloqueia primeiro a wallet com `FOR UPDATE SKIP LOCKED`. Wallet ocupada é deixada para outro ciclo. Após o lock, relê estado e agenda; duas instâncias não aplicam o mesmo movimento. Contador, próxima data, saldo, ledger e estado compartilham o commit. Erro técnico desfaz tudo, preservando a tentativa para retomada; não recebe um failureCode de saldo insuficiente. O lote registra a falha e continua com outras operações. O shutdown aguarda a tentativa atual antes de fechar o pool.

Uma operação que falha tecnicamente de forma contínua requer a política de falhas permanentes das etapas de recuperação. O TTL aqui finaliza referências ainda não resolvidas após uma tentativa de negócio bem-sucedida; não converte erro técnico em rejeição financeira.

## Arquivos e verificação

- `src/application/reference-retry-policy.ts`: intervalos e limites, com comentários em português.
- `src/application/reprocess-pending-references.ts`: coordenação da tentativa e rejeição final.
- `src/infrastructure/workers/`: timer, integração NestJS e encerramento.
- `src/application/ports/repositories.ts` e `src/infrastructure/persistence/`: contratos, agenda, lock, mapeamento e migration.
- `src/application/reference-retry-policy.spec.ts` e `src/infrastructure/workers/pending-reference.worker.spec.ts`: backoff, limites de entrada, ausência de sobreposição e shutdown.
- `test/integration/pending-reference.spec.ts`: PostgreSQL real; chegada de referências, todos os processadores, zero, última tentativa, TTL, limite, replay, rollback técnico, continuidade do lote, duas conexões independentes, wallet ocupada, reinício, migration com pendências antigas e agendamento automático.

Execute `bun run db:migrate` antes de iniciar a aplicação. O worker começa automaticamente com `bun run start`. Para os testes: `bun run test:integration`.

As tarefas 22 a 24 integram os eventos de pendência, conclusão e rejeição à Outbox na mesma transação da tentativa. O publisher independente os envia ao SQS após commit; detalhes em [messaging.md](messaging.md).
