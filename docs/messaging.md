# Mensageria, eventos e encerramento — tarefas 20 a 25

## Executar localmente

O projeto usa o SDK oficial `@aws-sdk/client-sqs` com versão fixa e LocalStack `4.14.0`, fixado para manter o ambiente reproduzível. PostgreSQL e SQS rodam em containers reais, com portas expostas somente em loopback.

```powershell
bun install
bun run infra:up
bun run db:migrate
bun run sqs:setup
bun run start
```

Configure conforme `.env.example`: `MESSAGING_ENABLED=true`, `SQS_ENDPOINT=http://127.0.0.1:4566`, `AWS_REGION=us-east-1` e `SQS_ALLOWED_PROVIDERS=provider-a`. A lista pode ter vários provedores separados por vírgula. Credenciais fictícias são usadas somente no emulador em loopback; endpoints externos usam a cadeia padrão do SDK. Não versionar credenciais reais. Filas são provisionadas por comando explícito, não pelo startup da aplicação.

`MessagingModule` inicia consumer e publisher automaticamente quando habilitado. `MESSAGING_ENABLED=false` permite executar somente HTTP e persistir eventos para publicação posterior; isso não descarta a Outbox. A aplicação falha no startup se a mensageria habilitada não encontrar suas filas ou não tiver provedores configurados.

## 20 — Consumer SQS

`src/interfaces/sqs/wager-envelope.ts` valida JSON, tipo `WagerTransactionRequested`, messageId, data ISO-8601 UTC com milissegundos, campos exatos do contrato e provedor autorizado. HTTP e SQS usam a mesma validação em `src/interfaces/validation/wager-request.ts`; o adapter HTTP apenas traduz o erro para HTTP 400.

`wager-consumer.ts` passa pela Inbox e chama `SubmitWager.executeInTransaction` na mesma RepositorySession. O método HTTP `execute` usa a mesma preparação e processamento, preservando o tratamento de disputas de unicidade. No SQS, uma disputa SQL aborta o conjunto e provoca redelivery, que resolve o replay sem salvar a Inbox separadamente. Hash financeiro continua excluindo metadados de transporte. Hash da Inbox cobre o envelope inteiro com chaves ordenadas; redelivery deve conservar o conteúdo original, inclusive occurredAt.

Fluxo: receive → validar → Inbox → SubmitWager → ledger + resultado + Outbox → commit → delete/ACK. Rejeições de negócio e PENDING_REFERENCE são resultados persistidos e recebem ACK. Erro técnico desfaz tudo e não recebe ACK. Reenvio após commit e antes do ACK encontra a Inbox e não repete o saldo. Recomenda-se MessageGroupId igual ao walletId; a correção financeira continua protegida por locks de wallet e idempotência persistente, independentemente do grupo FIFO.

## 21 — Retry e DLQ

`src/infrastructure/messaging/sqs.ts` configura:

- `wager-transactions.fifo`: entrada, visibilidade de 30s, long polling de 20s.
- `wager-transactions-dlq.fifo`: erros permanentes e tentativas esgotadas.
- `wager-events.fifo`: eventos de integração.

RedrivePolicy nativa usa maxReceiveCount=5. O consumer também aplica o limite de cinco recebimentos. Falhas transitórias usam ChangeMessageVisibility com espera de 1, 2, 4, 8… segundos, limitada a 60s. Recebimentos do SQS determinam a contagem, que sobrevive ao crash; não é um contador em memória. Payload inválido, provedor desconhecido e conflitos de identidade/payload vão diretamente à DLQ; erros inesperados são tentados até o limite, evitando classificá-los prematuramente como erro de negócio.

O envio à DLQ acontece antes de apagar a origem. Se o envio falhar, a mensagem permanece na fila original. A DLQ conserva o corpo original e recebe FailureReason. Sua deduplicação usa o MessageId do transporte; janelas maiores de redelivery ainda exigem tratamento idempotente ao reprocessar a DLQ. Fazer redrive é uma decisão operacional explícita, não um loop automático. Usar DLQ pode interromper a ordenação completa de um grupo FIFO; recuperar operações dependentes continua exigindo referência/idempotência no domínio.

## 22 — Integration Events

`src/domain/integration-event.ts` fornece a classe abstrata com eventId, eventType, aggregateId, correlationId, causationId opcional, occurredAt ISO-8601, version e data. Data aceita somente JSON simples, copiado e congelado recursivamente; instâncias Money e Date não entram no payload. Valores monetários são MoneyProps produzidos por Money.toJSON().

`src/domain/wager-events.ts` contém as quatro subclasses concretas de versão 1: WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference e WalletBalanceChanged. LOSS também produz Processed. BalanceChanged depende de um ledger que realmente altera o saldo; zero, LOSS, rejeição e pendência não o geram.

No SQS, correlationId e causationId usam o messageId do envelope. No HTTP, correlationId usa o ID interno da transação, sem alterar o contrato existente do endpoint. Os metadados ficam persistidos na operação, para que o worker de referências preserve a correlação original. Replay não cria novos eventos. Cada nova transição de estado gera seu evento; retry que continua PENDING_REFERENCE não gera outra notificação de pendência.

## 23 — Transactional Outbox

`src/domain/outbox-message.ts` encapsula enqueue, rehydrate, isPending, isDue, markPublished e scheduleRetry. Identidade e envelope ficam imutáveis; datas são copiadas; retry aumenta attempts e agenda a próxima tentativa. Não há descarte automático de evento confirmado.

`src/application/persist-wager-outcome.ts` grava a transição e os eventos na mesma sessão. BET, WIN, LOSS, REFUND, ROLLBACK, abertura com saldo e finalização de referências usam esse fluxo. Migration202610030004 cria a tabela Outbox e persiste contexto de correlação. EntitySchema, mappers, repositories e UnitOfWork incluem a nova tabela; cópia profunda no mapper permite que o ORM normalize o JSON sem alterar o envelope imutável do domínio.

O fluxo financeiro não chama SQS. Falha ao salvar qualquer evento desfaz Inbox, operação, saldo e ledger. Depois do commit, o evento fica disponível mesmo se o processo morrer antes de publicar. A migration valida triggers diferidas de backfill antes de alterar a tabela no mesmo lote de migrations. Seu down perde o histórico Outbox; reversões são testadas apenas em schemas descartáveis.

## 24 — Publisher

`src/application/publish-outbox.ts` confirma um claim com FOR UPDATE SKIP LOCKED em transação curta. A migration 005 adiciona claim_token e lease_expires_at, com constraints de pareamento/validade e índice de recuperação. O lease de 90 s usa o relógio do banco. SendMessage ocorre fora da transação SQL. A confirmação usa o token e verifica o prazo antes de marcar publicação ou reagendar; um dono antigo não altera o registro. Se o processo morrer ou o commit final falhar, outra instância retoma após expiração, preservando eventId. O token protege o banco, mas não cancela um envio SQS já em voo; entrega duplicada continua possível e exige deduplicação no consumidor.

Após sucesso, marca publishedAt e confirma o commit. Falha de envio incrementa attempts e salva backoff de 1, 2, 4… até 60s. Falha do commit após envio mantém o evento pendente; a próxima tentativa usa o mesmo eventId e corpo. SQS FIFO usa eventId como MessageDeduplicationId e aggregateId como MessageGroupId. A publicação é **ao menos uma vez**: a deduplicação FIFO é temporária, portanto consumidores dos eventos devem deduplicar eventId persistentemente. Não há promessa de publicação exatamente uma vez ou de ordenação global entre publishers concorrentes.

`src/infrastructure/workers/outbox-publisher.worker.ts` consulta a cada segundo, processa até 25 eventos por ciclo e evita sobreposição na mesma instância. Nenhum evento desaparece só porque outra instância está publicando.

## 25 — Graceful Shutdown

`main.ts` já habilita os shutdown hooks do NestJS. `MessagingRuntime.beforeApplicationShutdown` para consumer/publisher; o worker de referências também para nessa fase. Somente depois, OnApplicationShutdown fecha PostgreSQL e o cliente SQS.

O consumer cancela long polling e não começa outra mensagem. A mensagem ativa tem 10 segundos de graça para terminar e receber ACK. A visibilidade é renovada a cada 10s enquanto ativa. Se precisar cancelar, AbortSignal chega à transação MikroORM; a consulta é cancelada e o rollback termina antes de devolver visibilidade zero. Uma renovação já em voo não pode esconder novamente a mensagem devolvida. O publisher também dá 10s para concluir; cancelamento conserva o evento pendente. O worker de referências cancela sua tentativa após a mesma janela, sem perder agenda nem movimentação parcial.

SIGKILL ou perda de energia não permite executar handlers: a visibilidade expira e Inbox/Outbox recuperam o trabalho. Windows não entrega SIGTERM ao JavaScript como Unix; o teste Windows invoca o mesmo handler via IPC. O teste em container Linux envia SIGTERM real ao processo filho e verifica rollback, retorno da mensagem e fechamento.

## Verificação e critérios

```powershell
bun run test
bun run test:integration
bun run test:e2e
bun x tsc --noEmit
bun run lint
bun run build
docker compose run --rm --no-deps messaging-test
```

`src/domain/outbox-message.spec.ts` verifica envelope, imutabilidade, rejeição de Money no JSON, datas e backoff. `test/integration/messaging.spec.ts` usa PostgreSQL e LocalStack reais com schemas/filas exclusivos por caso: atomicidade, rejeição de negócio, referência fora de ordem, ACK após commit, replay HTTP/SQS, retry, redrive nativo, DLQ indisponível, limite de tentativas, dois publishers, envio antes de falha do commit, reinício e shutdown do publisher.

`test/helpers/messaging-worker.ts` permite matar processos reais após commit e antes do ACK/publicação, e enviar SIGTERM durante consulta bloqueada. IDs de evento e ledger são conferidos após recuperação; saldo é reconciliado com a soma do ledger. A infraestrutura de teste limpa somente recursos gerados por ela e encerra seus processos antes de remover o schema.

Health, métricas e recuperação operacional estão implementados; a autenticação foi omitida conforme a opção permitida no desafio. Permissões IAM de produção e monitoramento da DLQ/idade da Outbox deverão acompanhar a implantação; credenciais locais não são uma configuração de produção.

Referências oficiais utilizadas: [SDK JavaScript SQS](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sqs_code_examples.html), [visibilidade e redelivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) e [LocalStack SQS](https://docs.localstack.cloud/aws/services/sqs/).
