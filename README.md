# Digital Wallet Platform

Este projeto foi desenvolvido para o desafio técnico de backend da Jungle Gaming. Ele recebe operações de apostas por HTTP ou SQS e processa BET, WIN, LOSS, REFUND e ROLLBACK.

O foco é manter o saldo correto mesmo quando uma mensagem chega repetida, fora de ordem ou ao mesmo tempo que outra operação. Cada movimentação fica registrada em um ledger imutável, ou seja, um histórico financeiro que não pode ser alterado ou apagado. O saldo da wallet precisa corresponder à soma dos créditos menos os débitos desse histórico.

Os valores monetários entram e saem como strings, como `"100.00"`. Os cálculos usam decimal.js e a persistência usa PostgreSQL `NUMERIC(20,2)`, para preservar a precisão do dinheiro.

## Stack utilizada

| Componente | Tecnologia | Uso no projeto |
| --- | --- | --- |
| Linguagem | TypeScript 6.0 | Modo estrito (`strict: true`) |
| Runtime, pacotes e testes | Bun 1.4.2 | Execução da aplicação, instalação de dependências e test runner |
| Framework | NestJS 12 | API HTTP, injeção de dependência e ciclo de vida dos workers |
| Banco de dados | PostgreSQL 17.6 | Persistência financeira, constraints e controle de concorrência |
| ORM | MikroORM 7.2 | Mapeamento de entidades, Unit of Work e migrations versionadas e reversíveis |
| Mensageria | AWS SQS + AWS SDK v3 | Recebimento de operações e publicação de eventos |
| Emulador AWS | LocalStack 4.14 | Filas SQS reais no ambiente local de desenvolvimento e testes |
| Orquestração local | Docker Compose | PostgreSQL, LocalStack e ferramentas de observabilidade |
| Precisão monetária | decimal.js 10.6 + `NUMERIC(20,2)` | Cálculos e persistência exatos, com valores monetários em strings |
| Qualidade de código | Oxlint e Prettier | Análise estática e formatação |
| Observabilidade | OpenTelemetry, Prometheus, Grafana e Jaeger | Traces, métricas e visualização; infraestrutura opcional via perfil Compose |

Versões das dependências estão registradas em `bun.lock`; as imagens dos serviços estão em `docker-compose.yml`. As decisões arquiteturais estão em [03 - Architecture.md](<03 - Architecture.md>).

## Como executar localmente

Para começar, tenha o Bun instalado e o Docker Desktop em execução com containers Linux. As portas 3000, 55432 e 4566 precisam estar livres. Na raiz do projeto, instale as dependências e copie o arquivo de configuração:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
```

Defina uma senha local em **DB_PASSWORD**, no arquivo `.env`. Esse arquivo não deve ser versionado; o Bun e o Docker Compose carregam suas configurações automaticamente.

Depois, inicie o banco e o LocalStack, aplique as migrations, crie as filas e execute a aplicação:

```powershell
bun run infra:up
bun run db:migrate
bun run sqs:setup
bun run start:dev
```

O comando `infra:up` aguarda o banco e o LocalStack ficarem disponíveis. As migrations são aplicadas explicitamente, sem execução automática ao iniciar o servidor. Para consultar migrations pendentes, use `bun run db:pending`.

O banco `dwp_test` é criado na primeira inicialização do volume PostgreSQL. Se você estiver reutilizando um volume antigo que não contém esse banco, será necessário criá-lo antes de rodar os testes de integração. O comando `db:rollback` pode remover dados e deve ser usado somente em ambientes descartáveis de teste.

As variáveis `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` e `DB_NAME` configuram o banco. `MESSAGING_ENABLED=true` ativa os workers; `SQS_ENDPOINT`, `AWS_REGION` e `SQS_ALLOWED_PROVIDERS` configuram as filas e os provedores aceitos. A aplicação usa a porta 3000 por padrão, ajustável com `PORT`.

As credenciais fictícias são usadas apenas no emulador local. Para acessar a AWS, o SDK utiliza sua cadeia padrão de credenciais.

Para executar a versão compilada:

```powershell
bun run build
bun run start:prod
```

O build gera o arquivo de entrada `dist/main.js`, usado pelo comando `start:prod`.

## API

O contrato da API está disponível em `GET /openapi.json`, no formato OpenAPI 3.0.3, e pode ser importado no Postman ou Swagger Editor.

A autenticação foi deixada fora desta demonstração, conforme permitido pelo desafio. O ponto de extensão e o desenho de uma integração com um provedor de identidade estão descritos em [03 - Architecture.md](<03 - Architecture.md>).

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

O exemplo abaixo cria uma wallet com `100.00 BRL`, aposta `25.00 BRL` e repete a mesma requisição para verificar a idempotência:

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

Ao repetir a requisição, o saldo continua em `75.00`, a versão permanece em 2 e existe apenas um débito no ledger. A resposta identifica a repetição com `idempotentReplay: true`. Se ocorrer um timeout, envie novamente **a mesma chave e o mesmo payload**; isso permite recuperar o resultado sem repetir o efeito financeiro.

WIN credita a wallet; LOSS registra o resultado sem movimentar saldo; REFUND devolve o valor de uma BET; ROLLBACK inverte uma BET, WIN ou REFUND. As reversões exigem uma referência válida, com o mesmo valor, provedor, jogador, wallet, moeda e rodada.

Os códigos HTTP ajudam o provedor a distinguir uma entrada inválida, uma rejeição de negócio e uma falha de infraestrutura:

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

## Como as mensagens são processadas

O projeto utiliza três filas: `wager-transactions.fifo` recebe operações, `wager-transactions-dlq.fifo` recebe mensagens que precisam de tratamento posterior e `wager-events.fifo` recebe os eventos de integração.

O consumer valida a mensagem e chama o mesmo caso de uso utilizado pelo HTTP. A Inbox registra as mensagens recebidas para impedir efeitos duplicados, e o ACK — confirmação de consumo — só ocorre depois do commit no banco. A Outbox guarda os eventos junto com o resultado financeiro e permite publicá-los depois, mesmo se o processo reiniciar. Como uma publicação pode se repetir, os consumidores externos precisam deduplicar pelo `eventId`.

As políticas de retry, referências fora de ordem e encerramento dos workers estão explicadas em [03 - Architecture.md](<03 - Architecture.md>).

## Como verificar o projeto

Com o PostgreSQL e o LocalStack em execução, rode os testes e as verificações de código:

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

Os testes de integração usam PostgreSQL e SQS via LocalStack em containers reais. Eles verificam concorrência com três processos Bun, mensagens repetidas, falhas e recuperação. Quando necessário, criam schemas e filas próprios; o teste de indisponibilidade também cria e encerra um container PostgreSQL separado. Use um banco de testes descartável, nunca um banco de produção.

As evidências das verificações estão em [docs/evaluation.md](docs/evaluation.md). Para entender as decisões e preparar a apresentação, consulte [docs/presentation.md](docs/presentation.md).

A documentação principal segue esta ordem: [01 - Challenge.md](<01 - Challenge.md>), [02 - Tasks.md](<02 - Tasks.md>) e [03 - Architecture.md](<03 - Architecture.md>). O documento 03 reúne o conteúdo de arquitetura solicitado no enunciado como `ARCHITECTURE.md`.

## Observabilidade e testes de carga

Para acompanhar métricas e traces localmente, inicie as ferramentas de observabilidade e habilite o tracing:

```powershell
bun run observability:up
$env:OTEL_ENABLED = 'true'
bun run start
```

Depois de iniciar os serviços, acesse o Grafana em http://localhost:3001/d/dwp, o Prometheus em http://localhost:9090 e o Jaeger em http://localhost:16686. As ferramentas são configuradas automaticamente para uso local, com leitura anônima e dados efêmeros. O Prometheus coleta métricas da API na porta 3000 a cada 5 segundos; se mudar essa porta, ajuste `docker/observability/prometheus.yml`.

O tracing fica desativado por padrão. Quando habilitado, registra requisições HTTP, transações SQL e consumo SQS, exportando para `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` via OTLP HTTP. As operações SQL são associadas ao fluxo HTTP ou SQS dentro do processo, mas ainda não há propagação W3C entre serviços e filas. Os traces não coletam corpos de requisição, texto SQL ou valores monetários. Referência: [exportadores oficiais OpenTelemetry](https://opentelemetry.io/docs/languages/js/exporters/).

Para executar o teste de carga:

```powershell
bun run test:load
# Para mudar o tamanho da próxima execução:
$env:LOAD_REQUESTS = '500'
$env:LOAD_CONCURRENCY = '16'
bun run test:load
```

O teste cria uma API isolada, um schema `load_test_*` em `dwp_test` e filas próprias, com publicação SQS real em paralelo. Exercita wallets diferentes, operações sobre a mesma wallet e 50 envios duplicados. Ao terminar, verifica a correspondência entre saldo e ledger, o efeito único das operações e a ausência de eventos pendentes antes de limpar o ambiente.

Cada execução atualiza [docs/load-results.json](docs/load-results.json) com o ambiente, a taxa de processamento, as latências p50/p95/p99, os erros, os conflitos e o atraso de publicação. Os percentis usam o método nearest-rank e incluem o tempo até a resposta; o aquecimento é medido separadamente.

Esses resultados descrevem um experimento local com uma API e oito conexões, sem estimar capacidade de produção. Os cenários com múltiplos processos são verificados na integração. Replays também precisam ser analisados separadamente: responder a uma operação repetida não representa uma nova movimentação financeira.

O ledger por wallet atende ao escopo do desafio. Partidas dobradas ficam como evolução opcional, pois exigem definir contas de contrapartida e novas migrations.

## Verificação automática e histórico maior

O workflow `.github/workflows/ci.yml` reúne instalação pelo lockfile, formatação, verificação de tipos, lint, testes unitários, build, integração real e E2E no Linux. A integração inclui três processos e encerramento por SIGTERM. Sua execução no GitHub ainda está pendente; os resultados locais estão registrados separadamente.

Também é possível medir o comportamento com uma wallet que já possui histórico:

```powershell
bun run test:load:history
```

Esse experimento prepara 500 apostas na wallet disputada e acrescenta 25 ms de atraso antes de cada envio SQS real. Salva `docs/load-history-results.json`, sem substituir o resultado da carga padrão. `LOAD_HISTORY_ENTRIES`, `LOAD_SQS_DELAY_MS` e `LOAD_DRAIN_TIMEOUT_MS` permitem ajustar o experimento. O histórico fica fora dos percentis, mas entra na auditoria final; backlog e atraso de publicação incluem a preparação. Veja [docs/performance.md](docs/performance.md).

## Como a Outbox se recupera de falhas

Antes de publicar, o worker reserva um evento no banco por 90 segundos e recebe um token que identifica essa reserva. O envio ao SQS acontece depois do commit da reserva, sem manter uma conexão SQL ocupada durante a chamada de rede.

Se o processo parar, outra instância pode retomar o evento quando a reserva vencer. O token impede que um worker antigo confirme ou reagende um evento já assumido por outro. Ainda pode haver publicação duplicada se o envio ocorrer e a confirmação no banco falhar; por isso, o `eventId` permanece o mesmo.

Ao atualizar uma instalação existente, pare os publishers antigos, execute `bun run db:migrate` e inicie as instâncias na nova versão. Os custos e as garantias dessa estratégia estão em [03 - Architecture.md](<03 - Architecture.md>).
