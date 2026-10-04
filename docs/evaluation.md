# Evidências de avaliação — tarefas 30–38

A pontuação pertence ao avaliador. Extras não substituem os critérios obrigatórios/eliminatórios.

| Critério            | Peso | Implementação e evidência                                                                                                                  |
| ------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Correção financeira |   20 | Money/Wallet/ledger/processadores; testes em `src/domain`, `src/application/wager-operations.spec.ts` e integração financeira/persistência |
| Concorrência        |   20 | Lock por wallet, CAS/UNIQUE; `test/integration/concurrency.spec.ts` disputa saldo/reversões/50 duplicatas em três processos                |
| Idempotência        |   15 | Hash/chave/resultado persistidos; `submit-wager.spec.ts`, `idempotency.spec.ts` e redelivery/restart em `messaging.spec.ts`                |
| Mensageria/falhas   |   15 | Inbox/Outbox/ACK/retry/DLQ/agenda/shutdown; `messaging.spec.ts`, `pending-reference.spec.ts`, SIGTERM Linux via Docker                     |
| Modelagem           |   10 | Domínio independente, ports, DTOs, mappers e migrations; `ARCHITECTURE.md` explica decisões/limites                                        |
| Testes              |   10 | Unitários, PostgreSQL/SQS reais, processos reais; comandos `test`, `test:integration`, `test:e2e`                                          |
| Observabilidade     |    5 | Logs/métricas/health/reconciliação; `observability.spec.ts`, `queries-observability.spec.ts`, `health-outage.spec.ts`                      |
| Documentação        |    5 | README, ARCHITECTURE e roteiro `docs/presentation.md`                                                                                      |

30: revalidar testes Money, Wallet, estados, operações e idempotência; novos testes verificam contratos técnicos e tracing.

31–32: banco/filas reais comprovam commit/rollback, constraints/migrations, identidade após restart, Inbox/Outbox, retries, crash antes de ACK, múltiplos publishers e três processos independentes. Auditoria `test/helpers/financial-consistency.ts` reconstrói saldos via SQL em concorrência e a cada cenário de mensageria. Toda wallet deve ser não negativa e coincidir com seu ledger. Fixtures de corrupção para testar diagnóstico têm schema exclusivo e não alteram dados da aplicação.

33: HTTP distingue payload, identidade, rejeição financeira, referência pendente e falha técnica; erros técnicos têm helper comum e não expõem driver/SQL/segredos.

34: opção sem autenticação explicitada no guard/OpenAPI/docs; port e metadata indicam extensão IdP/autorização. Isso não é autenticação implementada.

35: README cobre instalação/infra/migrations/filas/API/testes; ARCHITECTURE descreve estado atual; documentos originais preservados.

36: revisar diff/escopo, dinheiro como strings/Decimal/NUMERIC, constraints contra negativos/duplicação/alteração de ledger, commit antes de publicação, testes reais e documentação. Rodar TypeScript strict, lint, formatação, build e todas as suites. Numbers usados em tempo/versão/contagens não representam dinheiro.

37: roteiro preparado; capacidade de explicar sem ler depende do estudo do candidato.

38: OpenAPI, tracing, dashboard e carga acrescentados. Resultados em `load-results.json`: ambiente, nearest-rank p50/p95/p99, erro, throughput e lag. `lockConflicts=0` significa ausência de timeout/deadlock/CAS falho, não ausência de espera. Lag máximo é amostrado. Replay conta como requisição, não como nova transação financeira. Carga usa uma API/oito conexões; integração comprova multiprocesso separadamente.

Partidas dobradas ficam opcionais e não implementadas: exigiriam definir contas/contrapartidas além do requisito de ledger por wallet.

## Verificação realizada em 04/10/2026

- `bun run test`: 230 testes aprovados, zero falhas.
- `bun run test:integration`: 257 aprovados, com PostgreSQL/SQS reais e container descartável para health outage.
- `bun run test:e2e`: 1 aprovado.
- `docker compose run --rm --no-deps messaging-test`: 25 aprovados novamente em Linux, incluindo SIGTERM nativo; são repetição de parte da integração, não 25 casos novos.
- `bunx tsc --noEmit`, `bun run lint` e `bun run build`: concluídos sem erro; lint sem avisos. O build compilado também iniciou e respondeu readiness.
- Grafana: dashboard `dwp` provisionado com seis painéis e datasource Prometheus saudável. Prometheus confirmou scrape da API como `up`.
- Jaeger: API v3 confirmou traces `http.request` e `sql.transaction`, inclusive spans filhos exportados pelo SDK real.
- `bun run test:load`: 250 requisições medidas, 201 operações novas e 49 replays; zero erros, zero conflitos SQL, saldo/ledger consistentes e Outbox drenada. Ambiente, tracing/logs ligados e percentis constam do JSON, sem promessa de RPS de produção.

Os checks acima verificam a implementação; não garantem a nota atribuída pelo avaliador nem o domínio oral do candidato.
