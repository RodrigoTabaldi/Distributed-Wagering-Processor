# Persistência PostgreSQL — tarefa 07

## Executar localmente

Requisitos: Bun 1.x e Docker Desktop iniciado com containers Linux.

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env # apenas se .env ainda não existir
```

Edite `DB_PASSWORD` no `.env` antes de iniciar o banco. Este arquivo é ignorado pelo Git. Na implementação inicial já foi criado um `.env` local com senha aleatória; preserve-o. Trocar a senha no arquivo depois da criação do volume não muda a senha do PostgreSQL existente.

```powershell
bun run db:up
bun run db:migrate
bun run db:pending
bun run start:dev
```

O banco fica em `127.0.0.1:55432`, o serviço HTTP na porta 3000. Docker Compose mantém os dados no volume `postgres_data`. As credenciais configuradas são locais ao desafio; um ambiente de produção deverá separar o usuário de migrations do usuário da aplicação e limitar privilégios.

## Verificações

```powershell
bun run test
bun run test:integration
bun run test:e2e
bun x tsc --noEmit
bun run lint
bun run build
```

Os testes de integração usam exclusivamente `dwp_test`, criado no primeiro startup do volume pelo script `docker/postgres/init-test-database.sql`. Se o volume já existir sem esse banco, crie `dwp_test` manualmente; não remova um volume com dados para executar testes. As migrations de rollback são testadas em um schema descartável dentro desse banco. Cada teste usa identificadores próprios; o banco de desenvolvimento não é apagado.

`bun run db:rollback` pode remover tabelas e dados ao reverter migrations financeiras. Use apenas em banco descartável ou rollback explicitamente planejado. A migration 005 remove somente metadados de leases e exige publishers parados; não remove eventos. O startup da aplicação nunca executa migrations automaticamente.

## Organização

- `src/domain/`: regras financeiras, sem dependência de ORM.
- `src/infrastructure/persistence/entities.ts`: mapeamento das colunas com EntitySchema.
- `mappers.ts`: conversão entre colunas e objetos do domínio, usando as factories `rehydrate`.
- `orm.config.ts`: conexão e lista explícita de migrations, também compatível com o build compilado.
- `database.module.ts`: conexão injetável do NestJS e fechamento do pool.
- `migrations/`: schema SQL versionado com `up` e `down`.
- `test/integration/persistence.spec.ts`: testes reais do banco.

`NUMERIC(20,2)` e `DecimalType('string')` preservam centavos sem conversão para `number`. A validação do contrato decimal continua obrigatória antes de persistir: PostgreSQL pode arredondar entradas com escala maior que a coluna, enquanto Money as rejeita.

## Garantias implementadas

Wallet única por jogador/moeda, saldo não negativo, unicidade de chave de idempotência e de transação externa por provedor, um lançamento por wallet/transação, aritmética do ledger, vínculos por jogador/wallet/moeda e uma reversão PROCESSED por referência/tipo.

Triggers bloqueiam UPDATE, DELETE e TRUNCATE do ledger e alteração de payload/estado terminal de transações. Triggers diferidas verificam saldo versus soma do ledger e correspondência de transações financeiras processadas com lançamentos no commit. Elas permitem gravar tudo na mesma transação SQL; qualquer falha desfaz o conjunto.

Os vínculos compostos são definidos na migration. Como os mapeamentos usam IDs escalares, o ORM não infere a ordem dessas dependências: a aplicação deverá fazer flush de wallet, depois transação e depois ledger dentro de um único `em.transactional()`, como demonstrado no teste. Cada execução usa `em.fork()` para isolar o contexto de entidades. Em caso de rollback, descarte o estado de domínio alterado e recarregue os dados antes de um retry.

## Repositories — tarefa 08

Os contratos ficam em `src/application/ports/repositories.ts`; implementações em `src/infrastructure/persistence/repositories.ts`. `PostgreSqlUnitOfWork` é injetado pelo token `UNIT_OF_WORK`, exportado por DatabaseModule. As interfaces retornam objetos do domínio, não registros do ORM.

Use `unitOfWork.transaction(async ({ wallets, wagers, ledger }) => { ... })` para gravações. Todos os repositories compartilham a mesma transação; uma falha na callback ou no commit desfaz o conjunto. Crie wallet → transação → ledger nessa ordem. Os INSERTs são imediatos, sem commits individuais. `findByIdForUpdate()` exige uma transação e bloqueia somente a wallet escolhida.

`wallets.save(wallet, expectedVersion)` exige a versão lida antes da movimentação; `wagers.updateState(transaction, expectedStatus, at, observedBalance)` exige o estado lido antes da transição. Um UPDATE sem registro correspondente lança PersistenceConflictError. A aplicação deverá recarregar os objetos após rollback; não existe retry automático nesta etapa.

`unitOfWork.read()` disponibiliza consultas em um contexto isolado, sem consistência de snapshot entre múltiplas leituras. O ledger usa cursor opaco versionado e vinculado à wallet, preservando microssegundos e desempate por ID. Limites: padrão 50, máximo 100. Não há métodos de edição/exclusão do ledger. Testes em `test/integration/repositories.spec.ts`.

## Limites destas etapas

Endpoints financeiros, Inbox, Outbox e workers estão implementados. Replay e disputas usam identidade persistida e locks por wallet; integração verifica três processos independentes. A migration 005 reserva publicação por token e lease, liberando a conexão SQL durante o envio SQS. README e o documento 03 de arquitetura descrevem o estado atual.

A reconciliação no commit soma todo o ledger da wallet e usa bloqueio somente dessa wallet. É uma escolha conservadora de correção para o desafio, com custo crescente conforme o histórico aumenta; desempenho de hot wallets deverá ser medido posteriormente. O índice `(wallet_id, created_at, id)` prepara a leitura por cursor. O campo `observed_balance` reserva a persistência do saldo da resposta original, inclusive em operações sem ledger; a aplicação ainda deverá preenchê-lo e utilizá-lo no replay.

As constraints, índices e triggers são mantidos nas migrations SQL. Não use geração automática de schema para substituir migrations, pois o mapeamento EntitySchema não descreve todas essas garantias.
