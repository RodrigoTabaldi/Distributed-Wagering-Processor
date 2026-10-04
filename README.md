# Digital Wallet Platform

Desafio técnico de wallet para BET, WIN, LOSS, REFUND e ROLLBACK. Dinheiro usa strings (`"100.00"`), decimal.js e PostgreSQL `NUMERIC(20,2)`. Saldo deve coincidir com CREDIT menos DEBIT do ledger imutável. Stack: Bun 1.4.2, NestJS 12, TypeScript strict, MikroORM 7.2, PostgreSQL 17.6, AWS SDK/SQS e LocalStack 4.14. Versões efetivas em `bun.lock`.

## Executar

Pré-requisitos: Bun e Docker Desktop em execução com containers Linux; portas 3000, 55432 e 4566 livres. Na raiz:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
```

Edite **DB_PASSWORD** em `.env` com uma senha local; não versione esse arquivo. Bun/Compose carregam `.env`.

```powershell
bun run infra:up
bun run db:migrate
bun run sqs:setup
bun run start:dev
```

`infra:up` inicia banco/emulador com healthchecks. O PostgreSQL cria `dwp_test` na inicialização do volume; um volume antigo sem esse banco exige criá-lo explicitamente antes da integração. O servidor não executa migrations automaticamente. `db:pending` consulta pendências; `db:rollback` é destrutivo e deve ser usado apenas em fixtures descartáveis, nunca para apagar ledger de produção.

Variáveis: `DB_HOST/PORT/USER/PASSWORD/NAME`; `MESSAGING_ENABLED=true` ativa workers; `SQS_ENDPOINT`, `AWS_REGION`, `SQS_ALLOWED_PROVIDERS=provider-a` configuram mensageria; `PORT` altera 3000. Credenciais fictícias são usadas somente para o endpoint loopback do emulador; AWS usa a cadeia padrão de credenciais.

```powershell
bun run build
bun run start:prod
```

O entrypoint compilado é `dist/main.js`, conforme `rootDir: src` em `tsconfig.build.json`.

## API

`GET /openapi.json` publica OpenAPI 3.0.3, importável no Postman/Swagger Editor. **A demonstração não autentica usuários/provedores.** Veja a decisão e a extensão OIDC em [03 - Architecture.md](<03 - Architecture.md>).

| Método | Endpoint                                                              | Finalidade                                                             |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/wallets`                                                            | Cria wallet; abertura positiva gera OPENING/ledger/Outbox atomicamente |
| GET    | `/wallets/:walletId`                                                  | Consulta saldo, versão e datas                                         |
| POST   | `/wagering/transactions`                                              | Executa operação; exige `Idempotency-Key`                              |
| GET    | `/wagering/transactions/:transactionId`                               | Consulta por ID interno                                                |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por identidade externa                                        |
| GET    | `/wallets/:walletId/ledger?limit=50&cursor=...`                       | Página estável; limite 1..100, próxima página usa `nextCursor`         |
| POST   | `/wallets/:walletId/reconciliation`                                   | Diagnóstico saldo versus ledger, sem corrigir dados                    |
| GET    | `/health/live`                                                        | Processo vivo                                                          |
| GET    | `/health/ready`                                                       | Banco e três filas disponíveis; caso contrário 503                     |
| GET    | `/metrics`                                                            | Prometheus; sem saldo/payload nos labels                               |

Exemplo PowerShell:

```powershell
$wallet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType 'application/json' -Body (@{
  playerId = [guid]::NewGuid().ToString()
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json)
$key = [guid]::NewGuid().ToString()
$payload = @{
  providerId = 'provider-a'
  externalTransactionId = [guid]::NewGuid().ToString()
  playerId = $wallet.playerId
  walletId = $wallet.id
  roundId = 'round-1'
  gameId = 'game-1'
  kind = 'BET'
  money = @{ amount = '25.00'; currency = 'BRL' }
} | ConvertTo-Json
$bet = Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -Headers @{ 'Idempotency-Key' = $key } -ContentType 'application/json' -Body $payload
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wagering/transactions -Headers @{ 'Idempotency-Key' = $key } -ContentType 'application/json' -Body $payload
Invoke-RestMethod -Uri "http://localhost:3000/wallets/$($wallet.id)"
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/wallets/$($wallet.id)/reconciliation"
```

Replay mantém saldo `75.00`, versão 2 e apenas um DEBIT. WIN credita; LOSS só registra resultado; REFUND devolve BET; ROLLBACK inverte BET/WIN/REFUND. Reversões exigem referência e igual valor/provider/player/wallet/moeda/rodada. Depois de timeout, repita com **a mesma chave**.

| Status | Significado                                                      |
| ------ | ---------------------------------------------------------------- |
| 201    | Wallet criada                                                    |
| 200    | Processada/replay/consulta                                       |
| 202    | Referência pendente, sem efeito financeiro antecipado            |
| 400    | Input inválido: dinheiro/UUID/identidade/referência/cursor       |
| 404    | Recurso de consulta ausente                                      |
| 409    | Wallet duplicada ou conflito de chave/identidade/payload         |
| 422    | Rejeição financeira persistida com `failureCode`                 |
| 503    | Infraestrutura/conflito SQL transitório; retry com a mesma chave |
| 502    | Falha técnica terminal persistida como FAILED; não repetir automaticamente |
| 500    | Erro inesperado sem revelar detalhes do driver                   |

## SQS e testes

Filas: `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo`. Entrada agrupada por wallet; envelope validado em `src/interfaces/sqs/wager-envelope.ts`. Consumer usa Inbox e o mesmo caso de uso do HTTP, confirmando ACK após commit. Outbox publica eventos versionados somente depois do commit; consumidores externos precisam deduplicar eventId. Retry/DLQ/Pending Reference/shutdown: [03 - Architecture.md](<03 - Architecture.md>).

```powershell
bun run test
bun run test:integration
bun run test:e2e
bun run typecheck
bun run format:check
bun run lint
bun run build
# SIGTERM nativo Linux:
docker compose run --rm --no-deps messaging-test
```

Integração usa PostgreSQL/SQS reais via LocalStack, schemas/filas próprios quando necessário e três processos Bun. O teste de indisponibilidade cria/encerra um container PostgreSQL próprio. Não aponte `dwp_test` para produção. Critérios/evidências: [docs/evaluation.md](docs/evaluation.md). Estudo/apresentação: [docs/presentation.md](docs/presentation.md). A documentação segue a ordem: [01 - Challenge.md](<01 - Challenge.md>), [02 - Tasks.md](<02 - Tasks.md>) e [03 - Architecture.md](<03 - Architecture.md>). O documento 03 corresponde ao ARCHITECTURE.md solicitado no enunciado e descreve a implementação atual.

## Extras opcionais

```powershell
bun run observability:up
$env:OTEL_ENABLED = 'true'
bun run start
```

Grafana: http://localhost:3001/d/dwp ; Prometheus: http://localhost:9090 ; Jaeger: http://localhost:16686 . Provisionamento automático, leitura anônima local e dados efêmeros. Prometheus coleta a API do host na porta 3000 a cada 5s; outra porta exige ajustar `docker/observability/prometheus.yml`.

Tracing fica desativado por padrão; exporta HTTP, SQL transaction e SQS consume via OTLP HTTP para `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. SQL é filho local de HTTP/SQS; **não há propagação W3C entre serviços/filas**. Não coleta bodies/SQL/dinheiro. Referência: [exportadores oficiais OpenTelemetry](https://opentelemetry.io/docs/languages/js/exporters/).

```powershell
bun run test:load
# Para mudar o tamanho da próxima execução:
$env:LOAD_REQUESTS = '500'
$env:LOAD_CONCURRENCY = '16'
bun run test:load
```

Carga cria API isolada em porta aleatória, schema `load_test_*` em `dwp_test` e filas próprias; usa publisher SQS real em paralelo. Mede wallets diferentes, mesma wallet e 50 duplicatas. [docs/load-results.json](docs/load-results.json) é substituído a cada execução e registra ambiente, throughput, p50/p95/p99, erros, conflitos e lag amostrado. Percentis nearest-rank incluem a resposta; aquecimento é separado. Auditoria final verifica saldo/ledger, efeito único e backlog zero antes da limpeza.

Carga local usa uma API/oito conexões; não é benchmark produtivo. Prova multiprocesso está na integração. Throughput de replay não equivale a novos efeitos financeiros. Partidas dobradas ficam como evolução opcional: exigem definir contas de contrapartida e novas migrations além do ledger por wallet requerido.

## Verificação automática e histórico maior

`.github/workflows/ci.yml` executa instalação pelo lockfile, formatação, tipos, lint, unitários, build, integração real e E2E no Linux. A integração inclui três processos e SIGTERM nativo. O workflow ainda precisa de uma execução no GitHub; os checks locais não equivalem a um resultado publicado de CI.

```powershell
bun run test:load:history
```

Esse experimento prepara 500 apostas na wallet disputada e acrescenta 25 ms de atraso antes de cada envio SQS real. Salva `docs/load-history-results.json`, sem substituir o resultado da carga padrão. `LOAD_HISTORY_ENTRIES`, `LOAD_SQS_DELAY_MS` e `LOAD_DRAIN_TIMEOUT_MS` permitem ajustar o experimento. O histórico fica fora dos percentis, mas entra na auditoria final; backlog e atraso de publicação incluem a preparação. Veja [docs/performance.md](docs/performance.md).

## Publicação sem ocupar conexão SQL

A Outbox usa reserva persistida por 90 s e token de propriedade. O envio SQS ocorre depois de confirmar a reserva, fora da transação SQL. Outra instância retoma claims vencidos; tokens antigos não podem confirmar nem reagendar o evento. Antes de iniciar esta versão, pare publishers antigos e execute bun run db:migrate. Veja custos, política de rollout e garantias em [03 - Architecture.md](<03 - Architecture.md>).
