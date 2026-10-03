# Architecture — Distributed Wagering Processor

## 1. Overview

O sistema processa transações financeiras de apostas recebidas por HTTP ou AWS SQS.

As duas entradas utilizam o mesmo fluxo de processamento para garantir que as regras financeiras sejam consistentes independentemente da origem da operação.

Fluxo principal:

HTTP / SQS
→ Application Use Case
→ Domain
→ PostgreSQL Transaction
→ Wallet + WagerTransaction + Ledger + Outbox
→ Commit
→ Outbox Publisher
→ SQS

O PostgreSQL é a fonte final de verdade para:

- saldo
- transações
- idempotência
- ledger
- inbox
- outbox
- controle de concorrência

---

## 2. Main Components

### HTTP API

Responsável por receber requisições externas.

Principais endpoints:

- criação de wallets
- envio de wager transactions
- consulta de wallets
- consulta de ledger
- consulta de transactions
- reconciliation
- health checks

Controllers não devem conter regras financeiras.

Eles recebem os dados, validam o contrato e chamam os casos de uso da aplicação.

---

### SQS Consumer

Responsável por receber operações assíncronas.

Fluxo:

SQS
→ Consumer
→ Inbox
→ ProcessWagerTransaction
→ PostgreSQL
→ ACK

O mesmo caso de uso utilizado pela API HTTP é utilizado pelo consumer.

O ACK da mensagem ocorre somente depois que a transação no PostgreSQL for confirmada.

---

### Application Layer

Responsável por coordenar os casos de uso.

Exemplos:

- CreateWallet
- ProcessWagerTransaction
- ReconcileWallet
- RetryPendingReference

A camada de aplicação coordena:

- domínio
- repositories
- transactions
- eventos

As regras financeiras principais permanecem nas classes de domínio.

---

## 3. Domain

O domínio não depende de:

- NestJS
- HTTP
- PostgreSQL
- MikroORM
- SQS

Principais objetos:

### Money

Representa um valor monetário.

Possui:

- amount
- currency

Dinheiro nunca é representado com `number`.

A entrada e saída do sistema utilizam strings decimais:

`"25.00"`

Internamente será utilizada uma representação decimal exata.

Money é imutável.

Operações como:

- add
- subtract
- negate

sempre retornam uma nova instância.

Operações entre moedas diferentes são rejeitadas.

---

### Wallet

Aggregate Root responsável pelo saldo.

Possui:

- id
- playerId
- currency
- balance
- version

A Wallet controla:

- crédito
- débito
- validação de moeda
- proteção contra saldo negativo

Uma alteração de saldo deve sempre estar relacionada a uma entrada correspondente no Ledger.

---

### WagerTransaction

Representa uma operação financeira.

Tipos:

- OPENING
- BET
- WIN
- LOSS
- REFUND
- ROLLBACK

Estados:

- PENDING
- PENDING_REFERENCE
- PROCESSED
- REJECTED
- FAILED

Estados terminais:

- PROCESSED
- REJECTED
- FAILED

Uma transação em estado terminal não pode voltar para outro estado.

---

### WalletLedgerEntry

Representa uma movimentação financeira imutável.

Direções:

- DEBIT
- CREDIT

Cada lançamento possui:

- valor
- saldo antes
- saldo depois
- transactionId
- walletId

Regra:

DEBIT:

`balanceBefore - money = balanceAfter`

CREDIT:

`balanceBefore + money = balanceAfter`

Entradas do ledger não são alteradas nem excluídas.

Uma reversão cria uma nova entrada em vez de modificar uma entrada anterior.

---

## 4. Persistence

PostgreSQL é utilizado como fonte de verdade.

Principais tabelas:

- wallets
- wager_transactions
- wallet_ledger_entries
- inbox_messages
- outbox_messages

As invariantes críticas são protegidas tanto pelo domínio quanto pelo banco.

Exemplos de constraints:

- uma wallet por player + currency
- saldo nunca negativo
- idempotency key única
- transação externa única por provider
- um ledger entry por transaction e wallet
- mensagem Inbox única por consumer + messageId

Migrations são versionadas e reversíveis.

---

## 5. Transactions

Toda alteração financeira deve ocorrer dentro de uma transação SQL.

Exemplo de processamento de BET:

BEGIN

→ verificar idempotência
→ bloquear wallet
→ criar/atualizar WagerTransaction
→ alterar Wallet
→ criar LedgerEntry
→ criar OutboxMessage

COMMIT

Se qualquer etapa falhar:

ROLLBACK

Isso garante que não seja possível, por exemplo:

- alterar saldo sem criar ledger
- criar ledger sem alterar saldo
- processar uma transação sem registrar seu evento

---

## 6. Concurrency

A unidade de concorrência é a Wallet.

Operações sobre a mesma wallet precisam ser serializadas de forma segura.

A estratégia inicial é pessimistic locking sobre a linha da wallet.

Conceitualmente:

`SELECT ... FOR UPDATE`

Isso garante que duas instâncias não utilizem o mesmo saldo simultaneamente.

Exemplo:

Saldo inicial:

`100.00`

Duas BET simultâneas:

`80.00`
`80.00`

Processamento esperado:

BET A
→ lock
→ saldo 100
→ débito 80
→ saldo 20
→ commit

BET B
→ espera lock
→ lê saldo 20
→ saldo insuficiente
→ REJECTED

Resultado:

- uma PROCESSED
- uma REJECTED
- saldo final 20
- apenas um DEBIT no ledger

O lock é por wallet, não global.

Wallets diferentes podem ser processadas em paralelo.

---

## 7. Idempotency

O sistema utiliza idempotência persistente.

A API exige:

`Idempotency-Key`

Exemplo:

`provider-a:transaction-123`

Cada operação também possui um `payloadHash`.

Fluxo:

Idempotency-Key inexistente
→ processar normalmente

Idempotency-Key existente + mesmo payloadHash
→ retornar resultado original
→ idempotentReplay = true

Idempotency-Key existente + payloadHash diferente
→ conflito

A garantia de unicidade é feita pelo PostgreSQL.

Nenhum cache em memória é utilizado como garantia de idempotência.

---

## 8. Payload Hash

O hash é calculado somente sobre os campos de negócio da operação.

Metadados de transporte e o próprio header de idempotência não participam do hash.

O objeto é transformado em uma representação JSON canônica antes do cálculo.

As chaves são ordenadas para garantir que objetos semanticamente iguais produzam o mesmo resultado.

O algoritmo utilizado será SHA-256.

---

## 9. Inbox

O Inbox protege o processamento de mensagens SQS duplicadas.

Identificação:

- consumerName
- messageId

Constraint:

UNIQUE `(consumerName, messageId)`

Fluxo:

mensagem chega
→ consultar Inbox

Já processada:
→ não executar novamente

Nova:
→ registrar
→ processar

Inbox, movimentação financeira, Ledger e Outbox participam da mesma transação SQL.

---

## 10. SQS Processing

Fila principal:

`wager-transactions.fifo`

DLQ:

`wager-transactions-dlq.fifo`

Fluxo:

SQS
→ Consumer
→ Inbox
→ ProcessWagerTransaction
→ Commit
→ ACK

O sistema assume entrega at-least-once.

Portanto mensagens podem ser entregues mais de uma vez.

A consistência não depende das propriedades FIFO da fila.

PostgreSQL continua sendo responsável pelas invariantes.

---

## 11. Retry and DLQ

Erros são separados em três categorias.

### Business Error

Exemplo:

- saldo insuficiente
- referência inválida

Resultado:

- transaction REJECTED
- ACK da mensagem
- sem retry

### Transient Infrastructure Error

Exemplo:

- PostgreSQL temporariamente indisponível
- SQS temporariamente indisponível

Resultado:

- mensagem não confirmada
- retry posterior

### Permanent Infrastructure Error

Após o limite configurado de tentativas:

→ DLQ

O número máximo de tentativas e estratégia de backoff serão definidos junto à configuração da fila.

---

## 12. Pending References

REFUND e ROLLBACK podem chegar antes da transação referenciada.

Nesse caso:

transaction
→ PENDING_REFERENCE

Nenhum movimento financeiro é realizado.

Um worker procura periodicamente transações PENDING_REFERENCE.

As tentativas utilizam exponential backoff.

Se a referência aparecer:

→ processar normalmente

Se o limite ou TTL for atingido:

→ REJECTED
→ failureCode de referência inexistente

---

## 13. Transactional Outbox

Eventos nunca são publicados diretamente durante a transação financeira.

Dentro da transação PostgreSQL é criado um OutboxMessage.

Fluxo:

BEGIN

→ processar operação
→ alterar wallet
→ criar ledger
→ criar outbox

COMMIT

Depois:

Outbox Worker
→ lê mensagem
→ publica SQS
→ marca como publicada

Isso resolve o cenário:

PostgreSQL COMMIT
→ aplicação morre
→ evento ainda existe na Outbox
→ outra instância publica posteriormente

---

## 14. Outbox Publisher

O Outbox Publisher executa independentemente do processamento financeiro.

Ele procura mensagens:

- não publicadas
- cujo nextAttemptAt já chegou

Múltiplas instâncias podem publicar simultaneamente.

A seleção dos registros utiliza locking no PostgreSQL.

Uma estratégia possível:

`FOR UPDATE SKIP LOCKED`

Publicações duplicadas podem acontecer.

Por isso os consumidores também precisam ser idempotentes.

---

## 15. Financial Operations

### OPENING

Operação interna criada ao abrir uma wallet com saldo inicial maior que zero.

Efeito:

CREDIT

Não pode ser recebida por API ou SQS.

### BET

Efeito:

DEBIT

Rejeitada se saldo for insuficiente.

### WIN

Efeito:

CREDIT

### LOSS

Não altera saldo.

Não gera LedgerEntry.

Continua sendo considerada PROCESSED.

### REFUND

Reverte uma BET.

Efeito:

CREDIT

Só pode ocorrer uma vez para a mesma referência.

### ROLLBACK

Inverte a movimentação da referência.

BET:
DEBIT → CREDIT

WIN:
CREDIT → DEBIT

REFUND:
CREDIT → DEBIT

Um rollback que provoque saldo negativo é rejeitado.

---

## 16. Reconciliation

O saldo da wallet é materializado para permitir leitura eficiente.

O Ledger continua sendo o histórico financeiro auditável.

A reconciliação calcula novamente o saldo utilizando o Ledger.

Comparação:

`storedBalance`

versus

`calculatedBalance`

Invariante esperada:

`wallet.balance == saldo reconstruído pelo ledger`

Caso exista divergência:

- não corrigir automaticamente
- registrar log
- incrementar métrica
- retornar inconsistent

---

## 17. Integration Events

Eventos mínimos:

- WagerTransactionProcessed
- WagerTransactionRejected
- WalletBalanceChanged
- WagerTransactionPendingReference

Cada evento possui:

- eventId
- eventType
- version
- aggregateId
- correlationId
- causationId
- occurredAt
- data

Valores monetários são serializados como:

`{ "amount": "25.00", "currency": "BRL" }`

---

## 18. Observability

Logs serão estruturados em JSON.

Contexto incluído quando disponível:

- correlationId
- messageId
- transactionId
- walletId
- providerId

Payload financeiro completo não será escrito nos logs.

Métricas mínimas:

- transactions por status
- duplicates
- retries
- DLQ messages
- lock conflicts
- outbox lag
- processing latency
- reconciliation failures

---

## 19. Health Checks

### Liveness

`GET /health/live`

Indica se o processo da aplicação está funcionando.

Não depende de serviços externos.

### Readiness

`GET /health/ready`

Verifica se a aplicação está pronta para processar operações.

Dependências verificadas:

- PostgreSQL
- SQS

Health checks não exigem autenticação.

---

## 20. Authentication

Autenticação não faz parte do núcleo de avaliação do desafio.

A arquitetura prevê integração futura com um Identity Provider utilizando OIDC.

Possíveis implementações:

- Keycloak
- Zitadel

Não será criada autenticação própria baseada em tabela de usuários e senhas.

A entrada HTTP terá um ponto de extensão para autenticação através de Guard/Provider.

Mensagens SQS são consideradas provenientes de um canal interno confiável.

A identidade do provider presente na mensagem ainda é validada pelas regras do domínio.

---

## 21. HTTP and SQS

Existem duas formas de entrada:

### HTTP

Utilizada quando o chamador precisa de resposta imediata.

HTTP
→ Controller
→ ProcessWagerTransaction

### SQS

Utilizada para processamento assíncrono.

SQS
→ Consumer
→ ProcessWagerTransaction

Ambas convergem para o mesmo caso de uso.

Não existem duas implementações diferentes das regras financeiras.

---

## 22. Architecture Flow

Fluxo HTTP:

Provider
→ HTTP Controller
→ ProcessWagerTransaction
→ PostgreSQL Transaction
→ Wallet
→ WagerTransaction
→ Ledger
→ Outbox
→ Commit
→ HTTP Response

Fluxo SQS:

SQS
→ Consumer
→ Inbox
→ ProcessWagerTransaction
→ PostgreSQL Transaction
→ Wallet
→ WagerTransaction
→ Ledger
→ Outbox
→ Commit
→ ACK

Publicação:

Outbox
→ Outbox Publisher
→ SQS

---

## 23. Core Invariants

O sistema deve sempre preservar:

1. Wallet nunca possui saldo negativo.
2. Dinheiro nunca utiliza ponto flutuante.
3. Uma movimentação financeira gera no máximo um LedgerEntry por wallet.
4. Toda mudança de saldo possui LedgerEntry correspondente.
5. LOSS não gera LedgerEntry.
6. Transação REJECTED não gera LedgerEntry.
7. Idempotência é persistente.
8. Uma mensagem duplicada não duplica movimentação.
9. Evento financeiro não é publicado antes do commit.
10. Múltiplas instâncias não podem causar lost update.
11. Ledger é imutável.
12. Wallet balance deve ser reconciliável pelo Ledger.

---

## 24. Main Architecture

Visão simplificada:

Provider
   |
   +------ HTTP ------+
   |                  |
   +------ SQS -------+
                      |
                      v
          ProcessWagerTransaction
                      |
                      v
               PostgreSQL
          +-----------+-----------+
          |           |           |
        Wallet      Ledger     Transaction
          |                       |
          +-----------+-----------+
                      |
                    Outbox
                      |
                    COMMIT
                      |
                      v
              Outbox Publisher
                      |
                      v
                     SQS![alt text](<04 - Arquitetura_Distributed_Wagering_Processor.jpg>)