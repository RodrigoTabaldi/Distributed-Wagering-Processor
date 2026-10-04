# LOSS — tarefa 14

LOSS registra a derrota da rodada sem movimentar dinheiro. O valor da aposta já foi descontado pela BET: registrar LOSS não desconta novamente.

O endpoint `POST /wagering/transactions` agora aceita `kind: "LOSS"`, mantendo o header obrigatório `Idempotency-Key` e o mesmo contrato de identidade e Money:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "loss-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "LOSS",
  "money": { "amount": "0.00", "currency": "BRL" }
}
```

Use IDs de uma wallet existente e envie `Idempotency-Key: provider-a:loss-123`. Não há referência externa em LOSS: o domínio e o DTO rejeitam esse campo para esse tipo.

## Regras e decisões

- `ProcessLoss` valida transação pendente, wallet, jogador e moeda. Usa o lock por wallet para salvar um saldo observado consistente com BET/WIN concorrentes.
- Marca a operação como `PROCESSED`, salva sua data de processamento e o saldo observado para replay.
- Não chama `Wallet.debit()`, `Wallet.credit()`, `wallets.save()` ou `ledger.create()`. Saldo, versão e data de atualização da wallet permanecem iguais.
- Money continua obrigatório e validado. Valores não negativos positivos são aceitos como informação do resultado, sem efeito financeiro, conforme o domínio existente. Não foi introduzida uma regra extra exigindo valor zero. Amount e currency continuam fazendo parte do hash de identidade.
- Registro da operação e resultado participam do mesmo commit. Falha ao persistir o estado desfaz o registro e permite retry com a mesma chave.
- Mesma chave e payload devolvem o resultado original com `idempotentReplay: true`; mudar o payload gera 409. Se outra operação mudar o saldo, o replay de LOSS ainda devolve o saldo observado na LOSS.

Sucesso e replay retornam HTTP 200. Entrada inválida retorna 400; conflito retorna 409. Não há rejeição por saldo insuficiente, pois LOSS não debita.

## Código e testes

- `src/application/process-loss.ts`: caso de uso, com comentários em português.
- `src/application/submit-wager.ts`: inclui LOSS no despacho e reaproveita a idempotência existente.
- `src/interfaces/http/submit-wager.dto.ts` e `wager.controller.ts`: aceitam LOSS e traduzem erros de validação.
- `src/application/submit-wager.spec.ts`: verifica a identidade do payload LOSS no hash.
- `test/integration/loss.spec.ts`: PostgreSQL real, invariância de wallet/ledger, saldo zero, replay, conflito, 50 reenvios simultâneos e rollback.

Execute `bun test ./test/integration/loss.spec.ts --timeout 30000`, com PostgreSQL configurado conforme [persistence.md](persistence.md). Cada teste financeiro compara o saldo final com o ledger reconstruído, inclusive quando ele está vazio.

Inbox, outbox e publicação de eventos permanecem nas tarefas correspondentes.
