# Inbox — tarefa 19

A Inbox registra mensagens recebidas para impedir que uma redelivery execute novamente sua operação. Sua identidade é `(consumerName, messageId)`, protegida por chave primária composta no PostgreSQL (que também garante UNIQUE). Consumidores diferentes podem processar a mesma mensagem independentemente. O hash SHA-256 identifica o conteúdo esperado; reutilizar a identidade com hash diferente lança `InboxPayloadConflictError`, sem alterar o registro original.

## Fluxo e atomicidade

`ProcessInboxMessage.execute(receipt, operation)` abre uma transação SQL, insere a identidade com `ON CONFLICT DO NOTHING` e bloqueia o registro. Se outro consumidor dessa mesma identidade estiver processando, aguarda seu commit ou rollback. Depois, relê o registro:

- Processado e mesmo hash: devolve `duplicate`, sem chamar a operação.
- Ainda não processado: chama a operação com a mesma `RepositorySession`, marca a conclusão e devolve `processed` após o commit.
- Hash divergente ou erro técnico: propaga o erro e desfaz a transação.

A callback deve usar os repositories e `executeInTransaction` dos casos de uso existentes. Abrir outra UnitOfWork dentro dela quebraria a atomicidade; não chame os métodos `execute` que iniciam uma transação independente. A integração concreta com SubmitWager e SQS está implementada na tarefa 20; veja [messaging.md](messaging.md).

Saldo, ledger, transação financeira e Inbox são confirmados juntos. Falha ao salvar a Inbox também desfaz o movimento financeiro. Se o banco confirma e o processo termina antes do ACK, a entrega seguinte encontra a Inbox processada. O ACK pertence à tarefa 20 e só pode ocorrer após o retorno bem-sucedido deste coordenador.

`processedAt` significa que a mensagem foi aceita e sua operação persistida, não necessariamente que houve movimento financeiro: uma rejeição de negócio ou `PENDING_REFERENCE` também conclui o recebimento. A pendência financeira continua sob responsabilidade do worker da tarefa 18.

## Arquivos

- `src/domain/inbox-message.ts`: factories receive/rehydrate, validações, datas protegidas e transição de conclusão única; sem dependências de ORM/NestJS.
- `src/application/process-inbox-message.ts`: coordenação transacional e deduplicação.
- `src/application/ports/repositories.ts`: contrato InboxRepository na RepositorySession.
- `src/infrastructure/persistence/entities.ts`, `mappers.ts`, `repositories.ts`, `unit-of-work.ts`, `orm.config.ts`: mapeamento, conversão e persistência na mesma sessão financeira.
- `src/infrastructure/persistence/migrations/Migration202610030003.ts`: tabela, identidade única, datas consistentes e proteção de identidade/conclusão contra UPDATE indevido.
- `src/domain/inbox-message.spec.ts` e `test/integration/inbox.spec.ts`: domínio e integração PostgreSQL real, incluindo redelivery, reinício, três conexões independentes, hash divergente, isolamento por consumidor e rollback financeiro.

Não há cache de deduplicação em memória nem expiração automática dos registros. Remover registros elimina a proteção para mensagens antigas; uma política de retenção deverá considerar a janela de redelivery antes de ser introduzida. Reverter a migration apaga somente a tabela Inbox e sua proteção, mas perde esse histórico: os testes de reversão usam schema descartável.

Execute `bun run db:migrate`. Testes: `bun test src/domain/inbox-message.spec.ts` e `bun test test/integration/inbox.spec.ts --timeout 30000`. O consumer e os testes reais de transporte SQS estão documentados na tarefa 20 em [messaging.md](messaging.md); esta etapa verifica a deduplicação e atomicidade no PostgreSQL.
