# Tarefas 25 a 30: consultas, diagnóstico e testes

## 25 — Encerramento seguro (já implementado)

`main.ts` habilita os hooks de shutdown do Nest. Os workers em
`src/infrastructure/workers/` param novas buscas, aguardam o trabalho ativo e,
após o período de tolerância, cancelam o SQL para concluir o rollback e devolver
a visibilidade da mensagem. O pool PostgreSQL fecha depois dos workers.
Os testes de `test/integration/messaging.spec.ts` verificam encerramento durante
processamento; o perfil Docker `messaging-test` verifica SIGTERM nativo no Linux.

## 26 — Consultas

`src/application/query-wallets.ts` monta respostas explícitas. O controller
`src/interfaces/http/query.controller.ts` valida parâmetros e expõe:

| Método e rota                                                             | Resultado                            |
| ------------------------------------------------------------------------- | ------------------------------------ |
| GET `/wallets/:walletId`                                                  | Saldo atual, jogador, versão e datas |
| GET `/wallets/:walletId/ledger`                                           | Histórico financeiro paginado        |
| GET `/wagering/transactions/:transactionId`                               | Estado da operação pelo ID interno   |
| GET `/providers/:providerId/wagering/transactions/:externalTransactionId` | Estado pela identidade do provedor   |

UUID inválido retorna 400; recurso inexistente retorna 404. Hash e chave de
idempotência não fazem parte das respostas de consulta.

O ledger aceita `limit` inteiro de 1 a 100, com padrão 50. Retorna `entries` e
`nextCursor` (null quando terminou). Na próxima chamada, envie o cursor recebido
sem interpretá-lo. Ele pertence à mesma wallet e preserva os microssegundos do
PostgreSQL. A ordenação `(created_at, id)` evita ambiguidades e não usa OFFSET.
Cursor opaco não significa criptografado ou uma forma de autorização: sua
estrutura é validada pelo repository, e nenhum valor entra no SQL por concatenação.

## 27 — Reconciliação

POST `/wallets/:walletId/reconciliation` retorna 200 com `walletId`,
`storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`.

`src/infrastructure/persistence/reconciliation-reader.ts` usa uma única instrução
SQL para ler saldo e somar TODOS os créditos menos TODOS os débitos, incluindo
OPENING. Isso oferece o mesmo snapshot para ambos, não bloqueia a wallet para
escrita e não depende do limite da paginação. A soma usa NUMERIC exato; Money
compara os valores e calcula `difference = storedBalance - calculatedBalance`.
Uma carteira sem lançamentos tem saldo calculado `0.00` e contagem zero.

Divergências geram log sem valores financeiros e incrementam uma métrica. A
reconciliação nunca corrige o saldo ou altera o ledger. Uma diferença positiva
significa que o saldo armazenado está acima do histórico calculado. Valores fora
da capacidade suportada por Money representam corrupção e retornam erro, sem
arredondamento ou correção silenciosa.

## 28 — Health

GET `/health/live` verifica somente a resposta do processo e retorna 200.
GET `/health/ready` exige PostgreSQL e as três filas SQS acessíveis; retorna 200
ou 503 com `checks.postgres` e `checks.sqs`, sem mensagens internas do driver.
Ambos funcionam sem autenticação. Readiness verifica SQS mesmo com consumer
desabilitado, pois a fila faz parte das dependências do processador.

`src/infrastructure/health/dependency-health.ts` executa sondagens em paralelo,
compartilha chamadas concorrentes e limita a resposta de PostgreSQL a cerca de
2,1 segundos e a de SQS a 2 segundos. Cancelamento de consulta e statement_timeout
protegem consultas ativas. Uma aquisição de conexão ainda pendente permanece
limitada a uma sondagem até concluir, evitando esgotar o pool.

`test/integration/health-outage.spec.ts` cria um PostgreSQL descartável com porta
fixa, sem volumes, desliga e reinicia esse container e verifica 503/200/recuperação.
Exige acesso ao Docker; não interrompe os containers do projeto.

## 29 — Observabilidade

`src/infrastructure/observability/observability.ts` usa o logger JSON do Nest e
AsyncLocalStorage para manter correlação por requisição. `x-correlation-id` é
validado ou gerado e devolvido na resposta. Operações HTTP persistem esse contexto
nos eventos; SQS usa o messageId do envelope como correlação e causa.

Logs incluem os identificadores disponíveis (`correlationId`, `messageId`,
`transactionId`, `walletId`, `providerId`). Mensagem inválida pode ter apenas ID
de transporte; não inventamos IDs financeiros. Uma lista permitida exclui payload,
saldo, chave de idempotência, hash, SQL e credenciais.

GET `/metrics` oferece texto Prometheus 0.0.4, sem dependência nova:

| Métrica                                   | Significado                                                           |
| ----------------------------------------- | --------------------------------------------------------------------- |
| `dwp_transactions_total{status}`          | Mudanças de estado confirmadas; inclui OPENING                        |
| `dwp_duplicates_total{source}`            | Replay de idempotência ou deduplicação da Inbox                       |
| `dwp_retries_total{source}`               | Tentativas reagendadas em SQS/Outbox e reprocessamentos de referência |
| `dwp_dlq_messages_total`                  | Encaminhamentos à DLQ confirmados pelo serviço                        |
| `dwp_lock_conflicts_total`                | Timeout de lock, deadlock, serialização ou conflito de versão         |
| `dwp_outbox_lag_seconds`                  | Idade do evento confirmado mais antigo ainda não publicado            |
| `dwp_processing_duration_seconds{source}` | Histograma de duração SQL/SQS, incluindo espera por lock              |
| `dwp_reconciliation_divergences_total`    | Consultas de reconciliação que encontraram divergência                |

Uma operação PENDING_REFERENCE que depois vira PROCESSED incrementa os dois
estados: este contador mede transições, não o número atual de registros por estado.
Em SQS, a duração mede validação e processamento SQL antes do ACK; falhas também
entram no histograma. O contador de DLQ mede encaminhamentos, incluindo eventual
reenvio após falha de ACK; não promete contagem de mensagens únicas da fila.

`recordAfterCommit` na sessão guarda observações e o UnitOfWork só as publica após
o commit, descartando-as no rollback. Falha na saída de log não altera resultado
financeiro. IDs aparecem nos logs, nunca nos labels das métricas, evitando
cardinalidade ilimitada. Os contadores são locais ao processo e reiniciam com ele;
Prometheus pode coletar cada instância. Lag consulta o banco e retorna 503 se essa
dependência falhar. OpenTelemetry e dashboards continuam opcionais.

## 30 — Testes unitários

Os testes existentes de Money, Wallet e WagerTransaction já verificam precisão,
entradas inválidas, moedas, versões, estados terminais e referências. A suíte
`src/application/wager-operations.spec.ts` adiciona testes isolados dos casos de
uso: BET, WIN, LOSS, REFUND, ROLLBACK, zero, rejeição sem efeitos financeiros,
referência fora de ordem, reversão repetida, replay com saldo original e conflito.
Os dublês de repository falham se uma chamada não configurada acontecer; não
substituem os testes de atomicidade e concorrência com PostgreSQL real.

Outras suítes novas verificam reconciliação, health, logs e métricas. Comentários
em português explicam a intenção e as garantias importantes.

## Verificação

```powershell
bun run test
bun run test:integration
bun run test:e2e
bunx tsc --noEmit
bun run lint
bun run build
docker compose run --rm --no-deps messaging-test
```

Antes das integrações, execute `bun run infra:up` e `bun run sqs:setup`.
O teste de indisponibilidade exige o CLI e o daemon Docker acessíveis ao processo.
