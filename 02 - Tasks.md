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

- [x] Criar enum ou tipo de failure codes
- [x] Criar código para BET sem saldo
- [x] Criar código diferente para rollback sem saldo
- [x] Criar código para referência inexistente
- [x] Criar código para tipo de referência inválido
- [x] Criar código para referência já refundada
- [x] Criar código para referência já revertida
- [x] Criar código para valor divergente
- [x] Criar código para conflito de moeda
- [x] Criar código para conflito de player
- [x] Criar código para conflito de wallet
- [x] Criar código para conflito de rodada
- [x] Criar código para conflito de idempotência
- [x] Salvar failureCode na transaction
- [x] Documentar significado dos códigos

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

- [x] Detectar referência ausente
- [x] Salvar como PENDING_REFERENCE
- [x] Não rejeitar imediatamente
- [x] Criar worker de reprocessamento
- [x] Implementar exponential backoff
- [x] Controlar tentativas
- [x] Definir limite de tentativas ou TTL
- [x] Reprocessar quando referência aparecer
- [x] Marcar PROCESSED quando possível
- [x] Rejeitar após limite
- [x] Usar failureCode apropriado
- [x] Criar testes

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

- [x] Criar classe `InboxMessage`
- [x] Criar `receive()`
- [x] Criar `rehydrate()`
- [x] Criar `isProcessed()`
- [x] Criar `markProcessed()`
- [x] Criar tabela inbox
- [x] Criar UNIQUE `(consumerName, messageId)`
- [x] Garantir deduplicação persistente
- [x] Não depender de cache em memória
- [x] Incluir inbox na mesma transaction SQL da operação
- [x] Criar testes de redelivery

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

- [x] Criar consumer
- [x] Ler `wager-transactions.fifo`
- [x] Validar envelope
- [x] Validar dados
- [x] Validar provider
- [x] Passar pela Inbox
- [x] Reutilizar o mesmo use case da entrada HTTP
- [x] Fazer ACK somente após commit
- [x] Erro de negócio deve ser terminal
- [x] Erro de negócio deve ser ACK
- [x] Erro transitório deve causar retry
- [x] Erro permanente deve ir para DLQ
- [x] Suportar redelivery
- [x] Garantir que redelivery não duplique saldo

---

## 21 — Retry e DLQ

- [x] Configurar `wager-transactions-dlq.fifo`
- [x] Configurar redrive policy
- [x] Definir limite de tentativas
- [x] Implementar retry
- [x] Implementar backoff
- [x] Encaminhar erro permanente para DLQ
- [x] Criar testes de retry
- [x] Criar testes de DLQ

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

- [x] Criar classe abstrata `IntegrationEvent`
- [x] Criar `toJSON()`
- [x] Garantir envelope estável
- [x] Serializar datas em ISO-8601
- [x] Serializar dinheiro usando MoneyProps
- [x] Nunca serializar instância Money diretamente

Eventos:

- [x] `WagerTransactionProcessed`
- [x] `WagerTransactionRejected`
- [x] `WalletBalanceChanged`
- [x] `WagerTransactionPendingReference`

Regras:

- [x] LOSS também gera `WagerTransactionProcessed`
- [x] `WalletBalanceChanged` somente quando saldo mudar

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

- [x] Criar classe `OutboxMessage`
- [x] Criar `enqueue()`
- [x] Criar `rehydrate()`
- [x] Criar `isPending()`
- [x] Criar `isDue()`
- [x] Criar `markPublished()`
- [x] Criar `scheduleRetry()`
- [x] Criar tabela outbox
- [x] Persistir evento dentro da mesma transaction financeira
- [x] Nunca publicar evento antes do commit
- [x] Garantir que evento confirmado não seja perdido após crash

---

## 24 — Outbox Publisher

Objetivo: publicar eventos confirmados.

Fluxo:

Outbox
→ worker
→ SQS
→ markPublished

Implementação:

- [x] Criar worker
- [x] Buscar eventos pendentes
- [x] Buscar somente eventos devidos
- [x] Suportar múltiplos publishers
- [x] Implementar locking dos registros
- [x] Considerar `FOR UPDATE SKIP LOCKED`
- [x] Publicar eventos
- [x] Marcar publishedAt após sucesso
- [x] Incrementar attempts em falha
- [x] Calcular próximo retry
- [x] Criar backoff
- [x] Tolerar publicação duplicada
- [x] Criar teste com dois publishers
- [x] Criar teste de crash depois do commit e antes da publicação

---

## 25 — Graceful Shutdown

Objetivo: encerrar aplicação sem perder mensagens.

- [x] Tratar SIGTERM
- [x] Parar de buscar novas mensagens
- [x] Finalizar mensagens em andamento quando possível
- [x] Caso necessário, devolver visibilidade ao SQS
- [x] Fechar conexão PostgreSQL
- [x] Encerrar workers
- [x] Encerrar consumer
- [x] Testar encerramento durante processamento

---

## 26 — Endpoints de Consulta

Implementar:

- [x] `GET /wallets/:walletId`
- [x] `GET /wallets/:walletId/ledger`
- [x] `GET /wagering/transactions/:transactionId`
- [x] `GET /providers/:providerId/wagering/transactions/:externalTransactionId`

Ledger:

- [x] Implementar `limit`
- [x] Implementar cursor
- [x] Garantir cursor estável
- [x] Garantir cursor opaco
- [x] Definir limite máximo de registros

---

## 27 — Reconciliation

Endpoint:

`POST /wallets/:walletId/reconciliation`

Objetivo: comparar saldo atual da wallet com saldo reconstruído pelo ledger.

Implementação:

- [x] Buscar wallet
- [x] Buscar ledger
- [x] Reconstruir saldo
- [x] Comparar com saldo armazenado
- [x] Calcular difference
- [x] Retornar storedBalance
- [x] Retornar calculatedBalance
- [x] Retornar difference
- [x] Retornar consistent
- [x] Retornar checkedEntries
- [x] Não corrigir divergência automaticamente
- [x] Logar divergência
- [x] Registrar divergência em métrica
- [x] Criar testes

---

## 28 — Health Checks

Implementar:

- [x] `GET /health/live`
- [x] `GET /health/ready`

Liveness:

- [x] Verificar apenas se processo está vivo
- [x] Não depender de PostgreSQL
- [x] Não depender de SQS

Readiness:

- [x] Verificar PostgreSQL
- [x] Verificar SQS

Regras:

- [x] Health checks sem autenticação
- [x] Derrubar PostgreSQL deve afetar readiness
- [x] Derrubar PostgreSQL não deve necessariamente afetar liveness

---

## 29 — Observabilidade

Logs:

- [x] Configurar logs estruturados em JSON
- [x] Incluir correlationId
- [x] Incluir messageId
- [x] Incluir transactionId
- [x] Incluir walletId
- [x] Incluir providerId
- [x] Não logar payload financeiro completo
- [x] Não logar dados sensíveis

Métricas:

- [x] Transações por status
- [x] Duplicatas detectadas
- [x] Retries
- [x] Mensagens em DLQ
- [x] Conflitos de lock
- [x] Outbox lag
- [x] Latência de processamento
- [x] Divergências de reconciliation

---

## 30 — Testes Unitários

Money:

- [x] Soma
- [x] Subtração
- [x] Negação
- [x] Zero
- [x] Comparações
- [x] Igualdade
- [x] Valores inválidos
- [x] Escala
- [x] Notação científica
- [x] NaN
- [x] Infinity
- [x] Moedas diferentes

Wallet:

- [x] Open
- [x] Credit
- [x] Debit
- [x] Saldo insuficiente
- [x] Currency mismatch
- [x] Version

WagerTransaction:

- [x] Estados
- [x] Transições
- [x] Estados terminais
- [x] Referência obrigatória
- [x] Referência inválida

Operações:

- [x] BET
- [x] WIN
- [x] LOSS
- [x] REFUND
- [x] ROLLBACK

Idempotência:

- [x] Mesmo payload
- [x] Payload diferente com mesma key

---

## 31 — Testes de Integração

Usar PostgreSQL real e LocalStack/MiniStack real em containers.

- [x] Executar migrations
- [x] Reverter migrations
- [x] Testar constraints
- [x] Testar persistência da wallet
- [x] Testar persistência do ledger
- [x] Testar persistência das transactions
- [x] Testar atomicidade wallet + ledger
- [x] Testar atomicidade wager + wallet + ledger
- [x] Testar atomicidade inbox + operação financeira
- [x] Testar atomicidade outbox + operação financeira
- [x] Testar redelivery
- [x] Testar dois publishers
- [x] Testar retry
- [x] Testar DLQ
- [x] Testar recuperação após restart

---

## 32 — Testes de Concorrência

Cenário 1:

Mesma BET enviada 50 vezes em paralelo.

- [x] Apenas um efeito financeiro
- [x] Apenas um débito
- [x] Replays não alteram saldo

Cenário 2:

Saldo:
`100.00`

BET A:
`80.00`

BET B:
`80.00`

- [x] Uma PROCESSED
- [x] Uma REJECTED
- [x] Saldo final `20.00`
- [x] Um ledger DEBIT

Cenário 3:

- [x] Wallets diferentes processadas em paralelo
- [x] Uma wallet não bloquear outra

Cenário 4:

- [x] Rodar pelo menos 3 instâncias/processos simultaneamente

Cenário 5:

- [x] Matar worker após commit e antes do ACK
- [x] Garantir redelivery
- [x] Garantir ausência de duplicação

Cenário 6:

- [x] Dois publishers sobre a mesma Outbox

Cenário 7:

- [x] REFUND entregue antes da BET

Cenário 8:

- [x] ROLLBACK entregue antes da referência

Cenário 9:

- [x] Reiniciar serviço durante processamento
- [x] Confirmar consistência final

Invariante final:

`wallet.balance == saldo reconstruído pelo ledger`

---

## 33 — HTTP Status

Objetivo: deixar claro para o provider o que aconteceu.

- [x] Definir status para payload inválido
- [x] Definir status para conflito de idempotência
- [x] Definir status para rejeição de negócio
- [x] Definir status para processamento pendente
- [x] Definir status para falha transitória de infraestrutura
- [x] Usar padrão consistente entre endpoints
- [x] Documentar decisões

---

## 34 — Autenticação

Autenticação não é prioridade principal neste desafio.

- [x] Decidir se será implementada
- [x] Se não implementar, deixar ponto de extensão claro
- [x] Documentar abordagem futura
- [x] Considerar OIDC
- [x] Considerar Keycloak ou Zitadel
- [x] Não criar autenticação artesanal
- [x] Não criar tabela própria de usuário/senha
- [x] Manter health checks públicos

---

## 35 — Documentation

README.md:

- [x] Explicar objetivo
- [x] Explicar stack
- [x] Explicar requisitos
- [x] Explicar instalação
- [x] Explicar como executar
- [x] Explicar Docker Compose
- [x] Explicar migrations
- [x] Explicar testes
- [x] Explicar endpoints
- [x] Adicionar exemplos de requests
- [x] Explicar filas
- [x] Explicar health checks

Architecture.md:

- [x] Documentar escolha do MikroORM
- [x] Documentar representação de Money
- [x] Documentar persistência de Money
- [x] Documentar transações SQL
- [x] Documentar locking
- [x] Documentar concorrência
- [x] Documentar idempotência
- [x] Documentar canonical JSON
- [x] Documentar payload hash
- [x] Documentar Inbox
- [x] Documentar Outbox
- [x] Documentar SQS
- [x] Documentar retry
- [x] Documentar DLQ
- [x] Documentar Pending Reference
- [x] Documentar graceful shutdown
- [x] Documentar autenticação
- [x] Documentar HTTP status
- [x] Documentar constraints
- [x] Documentar trade-offs
- [x] Documentar limitações

---

## 36 — Final Review

Verificar manualmente antes da entrega:

- [x] Nenhum valor monetário usa `number`
- [x] Nenhum valor monetário usa float
- [x] Nenhum valor monetário usa double
- [x] Saldo nunca pode ficar negativo
- [x] Race condition não pode causar saldo inválido
- [x] Nenhum débito pode ser duplicado
- [x] Nenhum crédito pode ser duplicado
- [x] Idempotência é persistente
- [x] Idempotência não depende de memória
- [x] Sistema funciona com múltiplas instâncias
- [x] Ledger é auditável
- [x] Ledger é imutável
- [x] Ledger não é apagado
- [x] Ledger não é sobrescrito
- [x] Evento nunca é publicado antes do commit
- [x] PostgreSQL real é usado nos testes relevantes
- [x] SQS real via LocalStack/MiniStack é usado nos testes relevantes
- [x] Migrations funcionam
- [x] Migrations podem ser revertidas
- [x] Todos os testes passam
- [x] README está atualizado
- [x] Architecture.md está atualizado

---

## 37 — Preparação para Apresentação

Material preparado em `docs/presentation.md`, com explicações, decisões, trade-offs e testes. Os itens abaixo permanecem como autoavaliação do candidato: produzir o roteiro não comprova que ele já domina a explicação oral.

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

OpenAPI, tracing, dashboard e carga implementados e verificados. Partidas dobradas ficam como evolução opcional documentada em `ARCHITECTURE.md`; não fazem parte da funcionalidade entregue.

- [x] Swagger / OpenAPI
- [x] OpenTelemetry
- [x] Dashboard de métricas
- [ ] Double-entry bookkeeping
- [x] Teste de carga
- [x] Criar `bun run test:load`
- [x] Medir throughput
- [x] Medir p50
- [x] Medir p95
- [x] Medir p99
- [x] Medir taxa de erro
- [x] Medir conflitos de concorrência
- [x] Medir outbox lag
