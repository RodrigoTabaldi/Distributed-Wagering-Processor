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

Internamente é utilizado `decimal.js`, recebendo valores monetários somente como strings, sem conversão para `number`. Uma configuração isolada com 21 dígitos significativos preserva os cálculos de soma e subtração dentro do limite escolhido, inclusive o dígito adicional necessário para detectar overflow.

O contrato de entrada exige exatamente duas casas decimais e rejeita valores negativos, notação científica, espaços e excesso de casas; não existe arredondamento silencioso. Resultados internos de subtração e negação podem ser negativos, permitindo calcular a diferença de reconciliação. `toString()` retorna apenas o valor decimal; `toJSON()` retorna `{ amount, currency }`.

O limite de magnitude é `999999999999999999.99`, compatível com o futuro mapeamento PostgreSQL `NUMERIC(20,2)`. Entradas e resultados que excedem esse limite são rejeitados. As migrations deverão preservar essa decisão; ainda não há persistência implementada. Códigos de moeda são validados pela lista ISO-4217 disponibilizada por `Intl.supportedValuesOf('currency')` no runtime Bun; BRL, USD e EUR são cobertos por testes, sempre com escala de duas casas conforme o contrato simplificado deste desafio.

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

No domínio implementado, `Wallet.open()` recebe identificadores, saldo inicial e data, e retorna `{ wallet, openingEntry }`. Uma abertura positiva exige os identificadores do lançamento e da transação interna OPENING; a criação e persistência dessa transação caberão à aplicação. A versão inicial permanece em 1. Abertura com zero não produz lançamento.

`credit()` e `debit()` recebem valor, identificadores do lançamento e da transação, e data. Retornam o lançamento validado antes de alterar saldo, versão e data de atualização. Operações de valor zero não geram lançamento nem incrementam a versão; valores negativos são rejeitados. Falhas de validação ou overflow preservam o estado anterior. Essas garantias são locais ao objeto: unicidade, idempotência, persistência atômica e concorrência entre instâncias ainda dependerão do PostgreSQL.

`rehydrate()` reconstrói o estado persistido sem repetir abertura ou movimentação. As datas são copiadas na entrada e nos getters para impedir alterações externas por métodos mutáveis de `Date`.

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

Implementação em `src/domain/wager-transaction.ts`: `create()` aceita operações externas e inicia em PENDING; rejeita OPENING. `createOpening()` é exclusiva do fluxo interno de criação da wallet e exige valor positivo. Os futuros adapters HTTP e SQS deverão usar somente `create()`; essa integração ainda não existe. `rehydrate()` reconstrói o estado persistido sem repetir as transições.

Transições permitidas: PENDING → PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED; PENDING_REFERENCE → PROCESSED, REJECTED ou FAILED. Repetir `markPendingReference()` enquanto aguarda uma referência é permitido e não muda o estado. Qualquer transição a partir de um estado terminal lança `InvalidTransactionStateError`. `processedAt` é preenchido somente ao marcar PROCESSED; rejeição/falha armazenam `failureCode`.

REFUND e ROLLBACK exigem referência externa. WIN aceita referência opcional a uma BET; BET, LOSS e OPENING não aceitam referência. Autorrefêrencias são rejeitadas. O domínio valida a referência resolvida por provider/identificador externo, player, wallet, moeda, rodada, tipo permitido e status PROCESSED. Reversões exigem valor integral igual ao original; o prêmio de WIN pode diferir da BET. `markProcessed()` exige o identificador interno quando há referência externa; a aplicação deverá validar a referência antes de chamar esse método. Uma referência existente mas não processada produz `REFERENCE_NOT_PROCESSED`; a futura aplicação distinguirá espera de referência pendente e rejeição de referência terminal inválida.

`ledgerDirectionFor()` retorna DEBIT para BET, CREDIT para WIN/REFUND/OPENING e a direção inversa para ROLLBACK. Retorna undefined para LOSS, valor zero e transações REJECTED/FAILED. Valor zero é aceito sem movimento financeiro; as demais validações de referência continuam necessárias na aplicação. `affectsBalance()` indica se a operação pode gerar movimentação, não se ela já foi aplicada. As referências e a ausência de reversões anteriores devem ser verificadas antes do processamento, independentemente desse resultado.

`matchesPayload()` compara o SHA-256 hexadecimal persistido; `assertMatchesPayload()` lança `IdempotencyConflictError` quando diverge. A chave fornecida não é substituída por um valor calculado. Cálculo do JSON canônico/hash, replay do resultado, busca por chave e garantias de unicidade são responsabilidades futuras da aplicação e do PostgreSQL, não desta classe.

Códigos iniciais de falha:

| Código | Significado |
| --- | --- |
| INSUFFICIENT_BALANCE | Saldo insuficiente para aposta |
| REVERSAL_INSUFFICIENT_BALANCE | Reversão causaria saldo negativo |
| REFERENCE_NOT_FOUND | Referência não localizada; rejeição após esgotar espera |
| REFERENCE_NOT_PROCESSED | Referência ainda não está PROCESSED |
| INVALID_REFERENCE_KIND | Tipo de referência não permitido |
| PROVIDER_MISMATCH / PLAYER_MISMATCH / WALLET_MISMATCH | Identidade da referência incompatível |
| CURRENCY_MISMATCH / ROUND_MISMATCH | Moeda ou rodada incompatível |
| REFERENCE_AMOUNT_MISMATCH | Valor da reversão diferente do original |
| REFERENCE_ALREADY_REFUNDED / REFERENCE_ALREADY_ROLLED_BACK | Reversão do mesmo tipo já processada; futura verificação no banco |
| PERMANENT_INFRASTRUCTURE_FAILURE | Falha permanente de infraestrutura |

O conflito de idempotência é um erro separado: não altera nem rejeita a transação original já registrada.

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

`WalletLedgerEntry.create()` exige identificadores preenchidos, data válida, valor positivo, saldos não negativos, moedas iguais e aritmética consistente. `rehydrate()` apenas reconstrói o registro persistido. Os campos públicos são somente leitura e congelados em execução; o valor monetário é um Money imutável e a data é copiada. A proteção do ledger contra UPDATE/DELETE e a unicidade por wallet/transação serão implementadas no schema PostgreSQL.

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

A tarefa 07 implementa PostgreSQL 17 em Docker Compose e MikroORM 7.2.0 com EntitySchema separado das classes de domínio. `DecimalType('string')` mapeia dinheiro para NUMERIC(20,2); mappers reconstroem Money e as entidades por `rehydrate()`. A lista de migrations é explícita, sem descoberta dependente de caminhos do código compilado. Não há sincronização automática de schema nem migrations no startup.

A migration cria wallets, wager_transactions e wallet_ledger_entries com constraints de unicidade, checks monetários, foreign keys compostas e índices de leitura. Um índice único parcial impede duas reversões PROCESSED do mesmo tipo/referência, permitindo registrar tentativas rejeitadas. Triggers impedem UPDATE/DELETE/TRUNCATE do ledger e alterações de transações terminais ou de seus dados de negócio.

Triggers diferidas verificam, no commit, saldo materializado contra a soma do ledger e a existência/correspondência de lançamentos de transações financeiras PROCESSED. O bloqueio é por wallet, não global. A soma completa do histórico é uma escolha conservadora com custo crescente, a ser medida nos testes de carga. Isso não substitui o futuro lock da aplicação nem os testes com três instâncias. Inbox/Outbox ainda serão adicionados em suas etapas.

Os mapeamentos usam IDs escalares e a migration mantém as foreign keys compostas; a aplicação deve controlar a ordem de flush dentro de `em.transactional()`. O teste demonstra wallet → transação → ledger com um único commit. Cada unidade de trabalho usa `em.fork()` e recarrega o estado após rollback. Instruções completas e limitações: `docs/persistence.md`.

A tarefa 08 adiciona contratos de repositories e UnitOfWork em `src/application/ports/repositories.ts`, sem dependência de ORM. As implementações PostgreSQL ficam em `infrastructure/persistence/`. `UNIT_OF_WORK` é o token de injeção NestJS exportado por DatabaseModule; o futuro caso de uso recebe a porta UnitOfWork.

`transaction(callback)` cria um contexto isolado com `em.fork().transactional()` e entrega os três repositories sobre o mesmo EntityManager. INSERTs imediatos preservam a ordem das foreign keys e continuam no mesmo commit. Gravações e locks são recusados fora de uma transação ativa. `read(callback)` cria um contexto isolado para consultas, sem prometer snapshot consistente entre várias consultas; a reconciliação deverá usar transação e lock apropriados.

WalletRepository usa SELECT FOR UPDATE para a wallet escolhida e UPDATE condicionado à versão esperada como proteção adicional contra gravações desatualizadas. WagerRepository oferece buscas por ID, provedor/ID externo e chave de idempotência; atualiza somente os campos de estado, condicionado ao estado esperado, e permite salvar observed_balance. Não resolve replay nem retries automaticamente. Consultas mutáveis usam refresh para não reutilizar valores antigos do Identity Map após updates nativos.

LedgerRepository oferece apenas inserção e consultas. A paginação usa cursor base64url versionado e vinculado à wallet, limite padrão 50/máximo 100 e ordenação crescente por (created_at, id), sem OFFSET. O cursor conserva os microssegundos do PostgreSQL; a data dos objetos de domínio conserva a precisão de milissegundos de Date. A paginação é uma consulta ao histórico disponível, não um snapshot congelado entre requisições. Testes reais cobrem datas iguais, microssegundos, limites, cursores inválidos, rollback, conflitos de versão/estado e locks em sessões independentes.

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
