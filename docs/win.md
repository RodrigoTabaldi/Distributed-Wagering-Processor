# WIN — tarefa 13

WIN credita um prêmio na wallet. Exemplo: uma BET de 25.00 deixa saldo 75.00; um WIN de 50.00 eleva o saldo a 125.00. O prêmio não precisa ter o mesmo valor da aposta.

O endpoint existente `POST /wagering/transactions` agora aceita `kind: "WIN"`, com o mesmo contrato de identidade, Money e header obrigatório `Idempotency-Key`. A referência opcional é `referenceExternalTransactionId`; ela deve identificar uma BET processada do mesmo provedor, jogador, wallet, moeda e rodada.

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "win-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "WIN",
  "money": { "amount": "50.00", "currency": "BRL" },
  "referenceExternalTransactionId": "transaction-123"
}
```

Use IDs existentes e envie `Idempotency-Key: provider-a:win-123`. Remova o campo de referência para um prêmio independente.

## Processamento e garantias

`ProcessWin` bloqueia a wallet no PostgreSQL e relê o estado da operação. Valida wallet, jogador e moeda; quando há referência, consulta por `(providerId, externalTransactionId)` e usa as regras do domínio para validar os vínculos. Uma referência de outro provedor não é resolvida como se fosse do provedor atual.

`Wallet.credit()` calcula o saldo usando Money, produz um ledger `CREDIT` e incrementa a versão. Registro da operação, saldo, ledger, estado `PROCESSED` e saldo observado compartilham o mesmo commit. Falhas técnicas desfazem as gravações.

Valor zero é processado sem modificar saldo/versão nem gerar ledger, mas a referência ainda é validada. Soma acima de `999999999999999999.99` é rejeitada com `BALANCE_LIMIT_EXCEEDED`, sem crédito. Esse código foi acrescentado à taxonomia de `FailureCode`.

Referências existentes incompatíveis geram `REJECTED` e um failureCode específico, sem crédito. Uma BET rejeitada não pode justificar um WIN referenciado: o código é `REFERENCE_NOT_PROCESSED`.

Referência ausente ou BET ainda pendente produz `PENDING_REFERENCE`, HTTP 202, sem crédito. `ProcessWin.execute(id)` pode retomar essa operação depois de a BET ser processada; o worker agendado, backoff e TTL pertencem à tarefa de referências fora de ordem e ainda não foram implementados nesta etapa.

## Idempotência compartilhada

O antigo `SubmitBet` foi renomeado para `SubmitWager`, assim como DTO, tipos e função de hash, porque agora atende BET e WIN. A regra de idempotência continua única: mesma chave e payload devolvem o resultado salvo; payload diferente gera 409. `kind` e a referência, quando presente, entram no hash. O hash dos payloads BET já existentes não muda, pois o campo opcional ausente não é serializado.

Enquanto pendente, um reenvio devolve o estado pendente com `idempotentReplay: true`. Depois da retomada e do commit, devolve o resultado final salvo. Replays nunca executam crédito novamente e não substituem o saldo original pelo saldo atual da wallet.

HTTP: 200 para processado/replay processado; 202 para referência pendente; 400 para entrada inválida; 409 para conflito; 422 para rejeição financeira; 503 para indisponibilidade transitória e 500 para falha inesperada.

## Arquivos e verificação

- `src/application/process-win.ts`: caso de uso do crédito e validação de referência, com comentários em português.
- `src/application/submit-wager.ts`: despacho BET/WIN e idempotência compartilhada.
- `src/interfaces/http/submit-wager.dto.ts`, `wager.controller.ts`, `wager.module.ts`: entrada, códigos HTTP e injeção de dependências.
- `src/domain/wager-transaction.ts`: novo failureCode de capacidade monetária.
- `test/integration/win.spec.ts`: endpoint com PostgreSQL real, crédito, zero, limites, referências, rollback, rejeição e 50 reenvios.
- `src/application/submit-wager.spec.ts`: hash inclui tipo e referência, preservando o vetor de BET da tarefa 12.

Para testar, execute `bun test ./test/integration/win.spec.ts --timeout 30000`. Nos testes de vínculos impossíveis de armazenar por causa das FKs, só a leitura incompatível é simulada; os efeitos finais continuam verificados no PostgreSQL.
