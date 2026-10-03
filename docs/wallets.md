# Criação de wallet — tarefa 9

Com PostgreSQL configurado conforme [persistence.md](persistence.md), execute as migrations e inicie a API com `bun run start`.

`POST /wallets` recebe somente este contrato:

```json
{
  "playerId": "b3b51e86-131a-42fc-92ab-9404cb456791",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

`playerId` deve ser UUID; maiúsculas são normalizadas. O valor é uma string não negativa com exatamente duas casas decimais; números JSON, notação científica, moedas inválidas e campos adicionais são rejeitados.

Exemplo em PowerShell, com a porta padrão 3000:

```powershell
$body = @{
  playerId = [guid]::NewGuid().ToString()
  initialBalance = @{ amount = '100.00'; currency = 'BRL' }
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType 'application/json' -Body $body
```

A resposta `201` contém `id`, `playerId`, `balance` (amount/currency) e `version: 1`. Saldo positivo cria uma transação interna `OPENING`, já `PROCESSED`, e um lançamento `CREDIT`. Saldo zero cria somente a wallet. Todas as gravações compartilham uma transação SQL e a resposta só é entregue depois do commit.

| Status | Significado |
| --- | --- |
| 201 | Wallet criada |
| 400 | Contrato ou Money inválido |
| 409 | Já existe wallet para jogador e moeda |
| 503 | Falha transitória de infraestrutura identificada |
| 500 | Falha inesperada, com mensagem pública genérica |

A consulta prévia dá uma resposta rápida para duplicatas; a constraint única do PostgreSQL impede duplicatas concorrentes. O repository traduz somente essa constraint para conflito de negócio. Dados de SQL e credenciais não são devolvidos ao cliente.

## Organização e verificação

- `src/interfaces/http`: DTO valida a entrada, controller traduz o resultado para HTTP e módulo registra as dependências.
- `src/application/create-wallet.ts`: coordena as regras do domínio e a persistência sem depender do NestJS ou MikroORM.
- `src/application/errors.ts`: define o conflito de wallet existente.
- `test/integration/create-wallet.spec.ts`: verifica o endpoint com PostgreSQL real, incluindo saldo zero, precisão, duplicatas concorrentes e rollback por falha no ledger.
- `src/interfaces/http/wallet.controller.spec.ts`: verifica a tradução segura de falhas para 503/500 usando falhas simuladas.

Execute `bun run test:integration` e `bun run test`. O teste concorrente desta tarefa usa dez requisições na mesma aplicação; a verificação com múltiplas instâncias permanece em sua tarefa específica. Autenticação, observabilidade completa e outbox seguem as tarefas posteriores do projeto.
