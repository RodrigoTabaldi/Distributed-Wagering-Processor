# Tasks — Distributed Wagering Processor

## 01 — Project Setup

- [ ] Confirmar Bun 1.x
- [ ] Configurar NestJS
- [ ] Confirmar TypeScript com `strict: true`
- [x] Instalar e configurar PostgreSQL
- [x] Instalar e configurar MikroORM
- [x] Instalar biblioteca decimal para valores monetários
- [ ] Instalar AWS SDK necessário para SQS
- [ ] Configurar LocalStack ou MiniStack
- [x] Criar `docker-compose.yml`
- [x] Adicionar PostgreSQL ao Docker Compose
- [ ] Adicionar LocalStack/MiniStack ao Docker Compose
- [ ] Criar fila `wager-transactions.fifo`
- [ ] Criar fila `wager-transactions-dlq.fifo`
- [x] Configurar variáveis de ambiente
- [x] Configurar conexão NestJS → PostgreSQL
- [x] Configurar migrations
- [x] Confirmar que migrations podem ser aplicadas
- [x] Confirmar que migrations podem ser revertidas
- [ ] Confirmar que aplicação, PostgreSQL e SQS sobem corretamente

---

## 02 — Estrutura Inicial

- [ ] Separar domínio
- [ ] Separar casos de uso
- [ ] Separar infraestrutura
- [ ] Separar entrada HTTP
- [ ] Criar módulos NestJS necessários
- [ ] Configurar Dependency Injection
- [ ] Evitar dependência de NestJS dentro das classes de domínio

Estrutura inicial sugerida:

src/
- domain/
- application/
- infrastructure/
- interfaces/

Responsabilidades:

domain/
- regras de negócio
- Money
- Wallet
- WagerTransaction
- WalletLedgerEntry

application/
- casos de uso
- criação de wallet
- processamento de apostas
- reconciliação

infrastructure/
- PostgreSQL
- MikroORM
- repositories
- SQS
- workers
- migrations

interfaces/
- controllers
- DTOs
- entrada HTTP
- consumer SQS

---

## 03 — Money

Objetivo: representar dinheiro de forma exata e segura.

- [x] Criar classe `Money`
- [x] Usar constructor privado
- [x] Criar `Money.from()`
- [x] Criar `Money.zero()`
- [x] Implementar `add()`
- [x] Implementar `subtract()`
- [x] Implementar `negate()`
- [x] Implementar `isZero()`
- [x] Implementar `isPositive()`
- [x] Implementar `isNegative()`
- [x] Implementar `isLessThan()`
- [x] Implementar `equals()`
- [x] Implementar `toJSON()`
- [x] Implementar `toString()`
- [x] Garantir imutabilidade
- [x] Validar moedas iguais em operações
- [x] Aceitar amount como string decimal
- [x] Garantir escala fixa de 2 casas
- [x] Rejeitar string vazia
- [x] Rejeitar `NaN`
- [x] Rejeitar `Infinity`
- [x] Rejeitar notação científica
- [x] Rejeitar mais de 2 casas decimais
- [x] Rejeitar valores negativos nos contratos de entrada
- [x] Nunca utilizar `number`, `float` ou `double` para dinheiro
- [x] Criar testes unitários para todas as operações
- [x] Criar teste de conflito de moeda

Exemplos válidos:
- `"0.00"`
- `"1.00"`
- `"25.50"`
- `"1000.99"`

Exemplos inválidos:
- `""`
- `"abc"`
- `"NaN"`
- `"Infinity"`
- `"1e3"`
- `"10.999"`
- `"-10.00"`

---

## 04 — Wallet

Objetivo: representar a carteira financeira do jogador.

Campos principais:

- id
- playerId
- currency
- balance
- version
- createdAt
- updatedAt

Implementação:

- [x] Criar classe `Wallet`
- [x] Usar constructor privado
- [x] Criar `Wallet.open()`
- [x] Criar `Wallet.rehydrate()`
- [x] Criar getter de balance
- [x] Criar getter de version
- [x] Criar getter de updatedAt
- [x] Implementar `credit()`
- [x] Implementar `debit()`
- [x] Impedir saldo negativo
- [x] Impedir movimentação com moeda diferente
- [x] Version iniciar em 1
- [x] Incrementar version apenas quando saldo mudar
- [x] Criar testes unitários

Testar:

- criação
- crédito
- débito
- saldo insuficiente
- moeda incompatível
- versionamento

---

## 05 — Ledger

Objetivo: registrar de forma imutável todas as movimentações financeiras.

- [x] Criar enum `LedgerDirection`
- [x] Criar `DEBIT`
- [x] Criar `CREDIT`
- [x] Criar classe `WalletLedgerEntry`
- [x] Usar constructor privado
- [x] Criar `create()`
- [x] Criar `rehydrate()`
- [x] Criar `isBalanced()`
- [x] Armazenar `walletId`
- [x] Armazenar `transactionId`
- [x] Armazenar `direction`
- [x] Armazenar `money`
- [x] Armazenar `balanceBefore`
- [x] Armazenar `balanceAfter`
- [x] Armazenar `createdAt`
- [x] Garantir imutabilidade
- [x] Não criar setters
- [x] Não permitir alteração após criação
- [x] Validar que CREDIT respeita `balanceBefore + money = balanceAfter`
- [x] Validar que DEBIT respeita `balanceBefore - money = balanceAfter`
- [x] Criar testes

---

## 06 — WagerTransaction

Objetivo: representar uma operação recebida de um provedor.

Kinds:

- OPENING
- BET
- WIN
- LOSS
- REFUND
- ROLLBACK

Status:

- PENDING
- PENDING_REFERENCE
- PROCESSED
- REJECTED
- FAILED

Implementação:

- [x] Criar enum `WagerTransactionKind`
- [x] Criar enum `WagerTransactionStatus`
- [x] Criar classe `WagerTransaction`
- [x] Usar constructor privado
- [x] Criar `create()`
- [x] Criar `rehydrate()`
- [x] Criar `markProcessed()`
- [x] Criar `markPendingReference()`
- [x] Criar `reject()`
- [x] Criar `fail()`
- [x] Criar `isTerminal()`
- [x] Criar `affectsBalance()`
- [x] Criar `requiresReference()`
- [x] Criar `matchesPayload()`
- [x] Criar `ledgerDirectionFor()`
- [x] Garantir que PROCESSED seja terminal
- [x] Garantir que REJECTED seja terminal
- [x] Garantir que FAILED seja terminal
- [x] Impedir transições após estado terminal
- [x] Garantir que REFUND exija referência
- [x] Garantir que ROLLBACK exija referência
- [ ] Impedir OPENING via HTTP (factory externa já rejeita; falta integração HTTP)
- [ ] Impedir OPENING via SQS (factory externa já rejeita; falta consumer)
- [x] Criar testes

---

## 07 — Persistência PostgreSQL

Objetivo: garantir as invariantes também no banco.

Criar tabelas:

- [x] `wallets`
- [x] `wager_transactions`
- [x] `wallet_ledger_entries`

Wallet:

- [x] PK
- [x] playerId
- [x] currency
- [x] balance
- [x] version
- [x] timestamps
- [x] UNIQUE `(playerId, currency)`
- [x] CHECK garantindo saldo não negativo

WagerTransaction:

- [x] PK
- [x] providerId
- [x] externalTransactionId
- [x] idempotencyKey
- [x] payloadHash
- [x] walletId
- [x] playerId
- [x] roundId
- [x] gameId
- [x] kind
- [x] amount
- [x] currency
- [x] status
- [x] referenceExternalTransactionId
- [x] referenceTransactionId
- [x] failureCode
- [x] processedAt
- [x] timestamps
- [x] UNIQUE adequado para idempotencyKey
- [x] UNIQUE adequado para provider + externalTransactionId

Ledger:

- [x] PK
- [x] walletId
- [x] transactionId
- [x] direction
- [x] amount
- [x] currency
- [x] balanceBefore
- [x] balanceAfter
- [x] createdAt
- [x] Garantir no máximo um lançamento por transaction + wallet

Migrations:

- [x] Criar migrations versionadas
- [x] Garantir rollback
- [x] Testar constraints diretamente no PostgreSQL

---

## 08 — Repositories

Objetivo: separar regras de negócio de persistência.

Wallet repository:

- [x] Buscar wallet
- [x] Buscar wallet com lock
- [x] Criar wallet
- [x] Salvar wallet
- [x] Verificar existência

Wager repository:

- [x] Buscar por id
- [x] Buscar por provider + externalTransactionId
- [x] Buscar por idempotencyKey
- [x] Criar transação
- [x] Atualizar estado

Ledger repository:

- [x] Criar lançamento
- [x] Buscar lançamentos da wallet
- [x] Buscar lançamento por transaction
- [x] Suportar paginação

---

## 09 — Criar Wallet

Endpoint:

`POST /wallets`

Fluxo:

request
→ controller
→ use case
→ transaction SQL
→ wallet
→ opening
→ ledger
→ commit

Implementação:

- [x] Criar DTO
- [x] Criar controller
- [x] Criar use case
- [x] Validar playerId
- [x] Validar Money
- [x] Verificar wallet duplicada
- [x] Criar Wallet
- [x] Se initialBalance > 0, criar transação OPENING
- [x] Criar ledger CREDIT correspondente
- [x] Salvar tudo na mesma transaction SQL
- [x] Retornar wallet criada
- [x] Retornar conflito quando já existir wallet para player + currency
- [x] Criar testes

---

## 10 — BET

Objetivo: implementar a primeira movimentação financeira real.

Fluxo:

BET
→ carregar wallet
→ validar moeda
→ validar saldo
→ debitar
→ criar ledger
→ marcar transaction PROCESSED
→ commit

Implementação:

- [x] Criar processamento de BET
- [x] Validar wallet
- [x] Validar player
- [x] Validar moeda
- [x] Validar saldo disponível
- [x] Executar `Wallet.debit()`
- [x] Criar ledger DEBIT
- [x] Marcar transação como PROCESSED
- [x] Incrementar version da wallet
- [x] Salvar tudo atomicamente
- [x] Rejeitar saldo insuficiente
- [x] Criar failureCode para saldo insuficiente
- [x] Não alterar saldo quando rejeitada
- [x] Não criar ledger quando rejeitada
- [x] Criar testes

---

## 11 — Concorrência

Objetivo: impedir duas instâncias de gastarem o mesmo saldo.

- [x] Definir estratégia por `walletId`
- [x] Implementar pessimistic locking ou estratégia equivalente
- [x] Não usar lock global
- [x] Impedir lost update
- [x] Permitir wallets diferentes em paralelo
- [ ] Criar métrica de lock conflicts futuramente — planejada para observabilidade

Cenário obrigatório:

Saldo inicial:
`100.00 BRL`

Execução simultânea:

BET A:
`80.00`

BET B:
`80.00`

Resultado obrigatório:

- [x] Exatamente 1 PROCESSED
- [x] Exatamente 1 REJECTED
- [x] Saldo final `20.00`
- [x] Exatamente 1 ledger DEBIT
- [x] Nenhum retry pode duplicar débito

Criar teste realmente paralelo.

---

## 12 — Idempotência

Objetivo: impedir efeitos financeiros duplicados.

Entrada obrigatória:

`Idempotency-Key`

Exemplo:

`provider-a:transaction-123`

Implementação:

- [x] Exigir header `Idempotency-Key`
- [x] Definir campos de negócio usados no hash
- [x] Criar JSON canônico
- [x] Ordenar chaves
- [x] Calcular payload hash
- [x] Persistir idempotency key
- [x] Persistir payload hash
- [x] Garantir UNIQUE no PostgreSQL
- [x] Requisição idêntica retornar resultado original
- [x] Retornar `idempotentReplay: true`
- [x] Mesma key com payload diferente retornar conflito
- [x] Não executar movimentação novamente
- [x] Garantir funcionamento com múltiplas instâncias
- [x] Criar teste com múltiplas requisições simultâneas

---

## 13 — WIN

Objetivo: creditar prêmio.

- [x] Implementar WIN
- [x] Validar wallet
- [x] Validar player
- [x] Validar moeda
- [x] Realizar crédito
- [x] Criar ledger CREDIT
- [x] Incrementar version
- [x] Marcar transaction PROCESSED
- [x] Permitir referência à BET quando fornecida
- [x] Validar referência quando fornecida
- [x] Criar testes

---

## 14 — LOSS

Objetivo: registrar resultado sem alterar saldo.

- [x] Implementar LOSS
- [x] Marcar transaction PROCESSED
- [x] Não alterar saldo
- [x] Não criar ledger
- [x] Não incrementar version da wallet
- [x] Criar testes

---

## 15 — REFUND

Objetivo: reverter uma BET processada.

Exemplo:

BET 25:
`100 → 75`

REFUND 25:
`75 → 100`

Regras:

- [x] Exigir `referenceExternalTransactionId`
- [x] Localizar referência por provider + externalTransactionId
- [x] Permitir referência somente para BET
- [x] Exigir referência PROCESSED
- [x] Validar mesmo provider
- [x] Validar mesmo player
- [x] Validar mesma wallet
- [x] Validar mesma moeda
- [x] Validar mesma rodada
- [x] Validar mesmo valor
- [x] Impedir segundo REFUND da mesma BET
- [x] Aplicar CREDIT
- [x] Criar ledger CREDIT
- [x] Marcar REFUND PROCESSED
- [x] Criar testes

---

## 16 — ROLLBACK

Objetivo: desfazer uma operação processada.

Pode referenciar:

- BET
- WIN
- REFUND

Regras:

- [x] Exigir referência
- [x] Buscar referência
- [x] Validar referência PROCESSED
- [x] Validar provider
- [x] Validar player
- [x] Validar wallet
- [x] Validar moeda
- [x] Validar rodada
- [x] Validar valor
- [x] Inverter direção financeira da referência
- [x] Se referência foi DEBIT, criar CREDIT
- [x] Se referência foi CREDIT, criar DEBIT
- [x] Impedir segundo ROLLBACK da mesma referência
- [x] Impedir saldo negativo
- [x] Criar failureCode específico para rollback sem saldo
- [x] Não usar o mesmo failureCode da BET sem saldo
- [x] Criar ledger correspondente
- [x] Criar testes

---

## 17 — Failure Codes

Objetivo: identificar rejeições de forma estável e legível por máquina.

- [ ] Criar enum ou tipo de failure codes
- [ ] Criar código para BET sem saldo
- [ ] Criar código diferente para rollback sem saldo
- [ ] Criar código para referência inexistente
- [ ] Criar código para tipo de referência inválido
- [ ] Criar código para referência já refundada
- [ ] Criar código para referência já revertida
- [ ] Criar código para valor divergente
- [ ] Criar código para conflito de moeda
- [ ] Criar código para conflito de player
- [ ] Criar código para conflito de wallet
- [ ] Criar código para conflito de rodada
- [ ] Criar código para conflito de idempotência
- [ ] Salvar failureCode na transaction
- [ ] Documentar significado dos códigos

---

## 18 — Pending Reference

Objetivo: tratar REFUND ou ROLLBACK que chegam antes da referência.

Fluxo:

operação chega
→ procura referência
→ referência não existe
→ PENDING_REFERENCE
→ salva
→ worker tenta depois

Implementação:

- [ ] Detectar referência ausente
- [ ] Salvar como PENDING_REFERENCE
- [ ] Não rejeitar imediatamente
- [ ] Criar worker de reprocessamento
- [ ] Implementar exponential backoff
- [ ] Controlar tentativas
- [ ] Definir limite de tentativas ou TTL
- [ ] Reprocessar quando referência aparecer
- [ ] Marcar PROCESSED quando possível
- [ ] Rejeitar após limite
- [ ] Usar failureCode apropriado
- [ ] Criar testes

---

## 19 — Inbox

Objetivo: deduplicar mensagens SQS.

Criar `InboxMessage` com:

- messageId
- consumerName
- payloadHash
- receivedAt
- processedAt

Implementação:

- [ ] Criar classe `InboxMessage`
- [ ] Criar `receive()`
- [ ] Criar `rehydrate()`
- [ ] Criar `isProcessed()`
- [ ] Criar `markProcessed()`
- [ ] Criar tabela inbox
- [ ] Criar UNIQUE `(consumerName, messageId)`
- [ ] Garantir deduplicação persistente
- [ ] Não depender de cache em memória
- [ ] Incluir inbox na mesma transaction SQL da operação
- [ ] Criar testes de redelivery

---

## 20 — SQS Consumer

Objetivo: permitir processamento assíncrono.

Fluxo:

SQS
→ Consumer
→ Inbox
→ mesmo use case do HTTP
→ transaction SQL
→ commit
→ ACK

Implementação:

- [ ] Criar consumer
- [ ] Ler `wager-transactions.fifo`
- [ ] Validar envelope
- [ ] Validar dados
- [ ] Validar provider
- [ ] Passar pela Inbox
- [ ] Reutilizar o mesmo use case da entrada HTTP
- [ ] Fazer ACK somente após commit
- [ ] Erro de negócio deve ser terminal
- [ ] Erro de negócio deve ser ACK
- [ ] Erro transitório deve causar retry
- [ ] Erro permanente deve ir para DLQ
- [ ] Suportar redelivery
- [ ] Garantir que redelivery não duplique saldo

---

## 21 — Retry e DLQ

- [ ] Configurar `wager-transactions-dlq.fifo`
- [ ] Configurar redrive policy
- [ ] Definir limite de tentativas
- [ ] Implementar retry
- [ ] Implementar backoff
- [ ] Encaminhar erro permanente para DLQ
- [ ] Criar testes de retry
- [ ] Criar testes de DLQ

---

## 22 — Integration Events

Objetivo: padronizar eventos publicados.

Criar `IntegrationEvent<T>` com:

- eventId
- eventType
- aggregateId
- correlationId
- causationId
- occurredAt
- version
- data

Implementação:

- [ ] Criar classe abstrata `IntegrationEvent`
- [ ] Criar `toJSON()`
- [ ] Garantir envelope estável
- [ ] Serializar datas em ISO-8601
- [ ] Serializar dinheiro usando MoneyProps
- [ ] Nunca serializar instância Money diretamente

Eventos:

- [ ] `WagerTransactionProcessed`
- [ ] `WagerTransactionRejected`
- [ ] `WalletBalanceChanged`
- [ ] `WagerTransactionPendingReference`

Regras:

- [ ] LOSS também gera `WagerTransactionProcessed`
- [ ] `WalletBalanceChanged` somente quando saldo mudar

---

## 23 — Transactional Outbox

Objetivo: impedir perda de eventos após commit.

Criar `OutboxMessage` com:

- id
- aggregateId
- eventType
- payload
- occurredAt
- attempts
- nextAttemptAt
- publishedAt

Implementação:

- [ ] Criar classe `OutboxMessage`
- [ ] Criar `enqueue()`
- [ ] Criar `rehydrate()`
- [ ] Criar `isPending()`
- [ ] Criar `isDue()`
- [ ] Criar `markPublished()`
- [ ] Criar `scheduleRetry()`
- [ ] Criar tabela outbox
- [ ] Persistir evento dentro da mesma transaction financeira
- [ ] Nunca publicar evento antes do commit
- [ ] Garantir que evento confirmado não seja perdido após crash

---

## 24 — Outbox Publisher

Objetivo: publicar eventos confirmados.

Fluxo:

Outbox
→ worker
→ SQS
→ markPublished

Implementação:

- [ ] Criar worker
- [ ] Buscar eventos pendentes
- [ ] Buscar somente eventos devidos
- [ ] Suportar múltiplos publishers
- [ ] Implementar locking dos registros
- [ ] Considerar `FOR UPDATE SKIP LOCKED`
- [ ] Publicar eventos
- [ ] Marcar publishedAt após sucesso
- [ ] Incrementar attempts em falha
- [ ] Calcular próximo retry
- [ ] Criar backoff
- [ ] Tolerar publicação duplicada
- [ ] Criar teste com dois publishers
- [ ] Criar teste de crash depois do commit e antes da publicação

---

## 25 — Graceful Shutdown

Objetivo: encerrar aplicação sem perder mensagens.

- [ ] Tratar SIGTERM
- [ ] Parar de buscar novas mensagens
- [ ] Finalizar mensagens em andamento quando possível
- [ ] Caso necessário, devolver visibilidade ao SQS
- [ ] Fechar conexão PostgreSQL
- [ ] Encerrar workers
- [ ] Encerrar consumer
- [ ] Testar encerramento durante processamento

---

## 26 — Endpoints de Consulta

Implementar:

- [ ] `GET /wallets/:walletId`
- [ ] `GET /wallets/:walletId/ledger`
- [ ] `GET /wagering/transactions/:transactionId`
- [ ] `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

Ledger:

- [ ] Implementar `limit`
- [ ] Implementar cursor
- [ ] Garantir cursor estável
- [ ] Garantir cursor opaco
- [ ] Definir limite máximo de registros

---

## 27 — Reconciliation

Endpoint:

`POST /wallets/:walletId/reconciliation`

Objetivo: comparar saldo atual da wallet com saldo reconstruído pelo ledger.

Implementação:

- [ ] Buscar wallet
- [ ] Buscar ledger
- [ ] Reconstruir saldo
- [ ] Comparar com saldo armazenado
- [ ] Calcular difference
- [ ] Retornar storedBalance
- [ ] Retornar calculatedBalance
- [ ] Retornar difference
- [ ] Retornar consistent
- [ ] Retornar checkedEntries
- [ ] Não corrigir divergência automaticamente
- [ ] Logar divergência
- [ ] Registrar divergência em métrica
- [ ] Criar testes

---

## 28 — Health Checks

Implementar:

- [ ] `GET /health/live`
- [ ] `GET /health/ready`

Liveness:

- [ ] Verificar apenas se processo está vivo
- [ ] Não depender de PostgreSQL
- [ ] Não depender de SQS

Readiness:

- [ ] Verificar PostgreSQL
- [ ] Verificar SQS

Regras:

- [ ] Health checks sem autenticação
- [ ] Derrubar PostgreSQL deve afetar readiness
- [ ] Derrubar PostgreSQL não deve necessariamente afetar liveness

---

## 29 — Observabilidade

Logs:

- [ ] Configurar logs estruturados em JSON
- [ ] Incluir correlationId
- [ ] Incluir messageId
- [ ] Incluir transactionId
- [ ] Incluir walletId
- [ ] Incluir providerId
- [ ] Não logar payload financeiro completo
- [ ] Não logar dados sensíveis

Métricas:

- [ ] Transações por status
- [ ] Duplicatas detectadas
- [ ] Retries
- [ ] Mensagens em DLQ
- [ ] Conflitos de lock
- [ ] Outbox lag
- [ ] Latência de processamento
- [ ] Divergências de reconciliation

---

## 30 — Testes Unitários

Money:

- [ ] Soma
- [ ] Subtração
- [ ] Negação
- [ ] Zero
- [ ] Comparações
- [ ] Igualdade
- [ ] Valores inválidos
- [ ] Escala
- [ ] Notação científica
- [ ] NaN
- [ ] Infinity
- [ ] Moedas diferentes

Wallet:

- [ ] Open
- [ ] Credit
- [ ] Debit
- [ ] Saldo insuficiente
- [ ] Currency mismatch
- [ ] Version

WagerTransaction:

- [ ] Estados
- [ ] Transições
- [ ] Estados terminais
- [ ] Referência obrigatória
- [ ] Referência inválida

Operações:

- [ ] BET
- [ ] WIN
- [ ] LOSS
- [ ] REFUND
- [ ] ROLLBACK

Idempotência:

- [ ] Mesmo payload
- [ ] Payload diferente com mesma key

---

## 31 — Testes de Integração

Usar PostgreSQL real e LocalStack/MiniStack real em containers.

- [ ] Executar migrations
- [ ] Reverter migrations
- [ ] Testar constraints
- [ ] Testar persistência da wallet
- [ ] Testar persistência do ledger
- [ ] Testar persistência das transactions
- [ ] Testar atomicidade wallet + ledger
- [ ] Testar atomicidade wager + wallet + ledger
- [ ] Testar atomicidade inbox + operação financeira
- [ ] Testar atomicidade outbox + operação financeira
- [ ] Testar redelivery
- [ ] Testar dois publishers
- [ ] Testar retry
- [ ] Testar DLQ
- [ ] Testar recuperação após restart

---

## 32 — Testes de Concorrência

Cenário 1:

Mesma BET enviada 50 vezes em paralelo.

- [ ] Apenas um efeito financeiro
- [ ] Apenas um débito
- [ ] Replays não alteram saldo

Cenário 2:

Saldo:
`100.00`

BET A:
`80.00`

BET B:
`80.00`

- [ ] Uma PROCESSED
- [ ] Uma REJECTED
- [ ] Saldo final `20.00`
- [ ] Um ledger DEBIT

Cenário 3:

- [ ] Wallets diferentes processadas em paralelo
- [ ] Uma wallet não bloquear outra

Cenário 4:

- [ ] Rodar pelo menos 3 instâncias/processos simultaneamente

Cenário 5:

- [ ] Matar worker após commit e antes do ACK
- [ ] Garantir redelivery
- [ ] Garantir ausência de duplicação

Cenário 6:

- [ ] Dois publishers sobre a mesma Outbox

Cenário 7:

- [ ] REFUND entregue antes da BET

Cenário 8:

- [ ] ROLLBACK entregue antes da referência

Cenário 9:

- [ ] Reiniciar serviço durante processamento
- [ ] Confirmar consistência final

Invariante final:

`wallet.balance == saldo reconstruído pelo ledger`

---

## 33 — HTTP Status

Objetivo: deixar claro para o provider o que aconteceu.

- [ ] Definir status para payload inválido
- [ ] Definir status para conflito de idempotência
- [ ] Definir status para rejeição de negócio
- [ ] Definir status para processamento pendente
- [ ] Definir status para falha transitória de infraestrutura
- [ ] Usar padrão consistente entre endpoints
- [ ] Documentar decisões

---

## 34 — Autenticação

Autenticação não é prioridade principal neste desafio.

- [ ] Decidir se será implementada
- [ ] Se não implementar, deixar ponto de extensão claro
- [ ] Documentar abordagem futura
- [ ] Considerar OIDC
- [ ] Considerar Keycloak ou Zitadel
- [ ] Não criar autenticação artesanal
- [ ] Não criar tabela própria de usuário/senha
- [ ] Manter health checks públicos

---

## 35 — Documentation

README.md:

- [ ] Explicar objetivo
- [ ] Explicar stack
- [ ] Explicar requisitos
- [ ] Explicar instalação
- [ ] Explicar como executar
- [ ] Explicar Docker Compose
- [ ] Explicar migrations
- [ ] Explicar testes
- [ ] Explicar endpoints
- [ ] Adicionar exemplos de requests
- [ ] Explicar filas
- [ ] Explicar health checks

Architecture.md:

- [ ] Documentar escolha do MikroORM
- [ ] Documentar representação de Money
- [ ] Documentar persistência de Money
- [ ] Documentar transações SQL
- [ ] Documentar locking
- [ ] Documentar concorrência
- [ ] Documentar idempotência
- [ ] Documentar canonical JSON
- [ ] Documentar payload hash
- [ ] Documentar Inbox
- [ ] Documentar Outbox
- [ ] Documentar SQS
- [ ] Documentar retry
- [ ] Documentar DLQ
- [ ] Documentar Pending Reference
- [ ] Documentar graceful shutdown
- [ ] Documentar autenticação
- [ ] Documentar HTTP status
- [ ] Documentar constraints
- [ ] Documentar trade-offs
- [ ] Documentar limitações

---

## 36 — Final Review

Verificar manualmente antes da entrega:

- [ ] Nenhum valor monetário usa `number`
- [ ] Nenhum valor monetário usa float
- [ ] Nenhum valor monetário usa double
- [ ] Saldo nunca pode ficar negativo
- [ ] Race condition não pode causar saldo inválido
- [ ] Nenhum débito pode ser duplicado
- [ ] Nenhum crédito pode ser duplicado
- [ ] Idempotência é persistente
- [ ] Idempotência não depende de memória
- [ ] Sistema funciona com múltiplas instâncias
- [ ] Ledger é auditável
- [ ] Ledger é imutável
- [ ] Ledger não é apagado
- [ ] Ledger não é sobrescrito
- [ ] Evento nunca é publicado antes do commit
- [ ] PostgreSQL real é usado nos testes relevantes
- [ ] SQS real via LocalStack/MiniStack é usado nos testes relevantes
- [ ] Migrations funcionam
- [ ] Migrations podem ser revertidas
- [ ] Todos os testes passam
- [ ] README está atualizado
- [ ] Architecture.md está atualizado

---

## 37 — Preparação para Apresentação

Conseguir explicar:

NestJS:
- Controller
- Service
- Provider
- Module
- Dependency Injection

PostgreSQL:
- transaction
- migration
- constraint
- UNIQUE
- CHECK
- index
- lock

Financeiro:
- Money
- Wallet
- Ledger
- DEBIT
- CREDIT
- reconciliation

Concorrência:
- race condition
- lost update
- pessimistic lock
- lock por wallet
- `FOR UPDATE`

Sistemas distribuídos:
- at-least-once
- idempotência
- Inbox
- Outbox
- retry
- exponential backoff
- DLQ
- crash recovery
- graceful shutdown

SQS:
- producer
- consumer
- message
- ACK
- visibility timeout
- redelivery
- DLQ

Para cada decisão importante conseguir responder:

- Qual problema isso resolve?
- Por que essa solução foi escolhida?
- O que aconteceria sem ela?
- Qual o trade-off?
- Qual teste comprova que funciona?

---

## 38 — Extras Opcionais

Fazer somente depois dos requisitos obrigatórios.

- [ ] Swagger / OpenAPI
- [ ] OpenTelemetry
- [ ] Dashboard de métricas
- [ ] Double-entry bookkeeping
- [ ] Teste de carga
- [ ] Criar `bun run test:load`
- [ ] Medir throughput
- [ ] Medir p50
- [ ] Medir p95
- [ ] Medir p99
- [ ] Medir taxa de erro
- [ ] Medir conflitos de concorrência
- [ ] Medir outbox lag