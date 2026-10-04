# Roteiro de apresentação — tarefa 37

Comece: “Dinheiro usa Decimal e NUMERIC. Cada alteração trava sua wallet e confirma saldo, transação, ledger e Outbox juntos. Repetições/crashes usam resultados persistidos e não duplicam efeitos.” Demonstre a BET e seu replay/reconciliação do README.

## Vocabulário

| Termo                         | Explicação no projeto                                               |
| ----------------------------- | ------------------------------------------------------------------- |
| Controller                    | Recebe HTTP, valida entrada e traduz resultado em status            |
| Service/caso de uso           | Coordena uma ação de negócio, como SubmitWager                      |
| Provider                      | Objeto que o Nest sabe criar/injetar, como UnitOfWork               |
| Module                        | Agrupa providers/controllers e define imports/exports               |
| Dependency Injection          | Nest entrega a implementação do contrato solicitado                 |
| Transaction                   | Confirma todas as gravações ou desfaz todas                         |
| Migration                     | Alteração versionada do esquema                                     |
| Constraint                    | Regra aplicada também pelo banco                                    |
| UNIQUE                        | Impede repetir identidades, como chave/provider-externalId          |
| CHECK                         | Valida uma condição, como saldo não negativo                        |
| Index                         | Facilita buscas/unicidade; custa espaço/escritas                    |
| Lock                          | Faz concorrentes esperarem pelo direito de alterar um registro      |
| Money                         | Valor imutável, decimal exato e moeda; cálculos criam outro objeto  |
| Wallet                        | Saldo/versão, sem permitir gastar além do disponível                |
| Ledger                        | Histórico imutável que explica alterações                           |
| DEBIT / CREDIT                | Saída / entrada; direção define o efeito do valor positivo          |
| Reconciliation                | Compara saldo ao ledger sem corrigir automaticamente                |
| Race condition                | Resultado depende da disputa entre execuções                        |
| Lost update                   | Uma escrita sobrescreve outra atualização                           |
| Pessimistic lock / FOR UPDATE | Trava a wallet antes de checar/alterar saldo; outras wallets seguem |
| At-least-once                 | Uma mensagem pode chegar repetidamente                              |
| Idempotência                  | Repetir operação devolve resultado sem efeito novo                  |
| Inbox                         | Mensagem/processamento persistidos para deduplicar                  |
| Outbox                        | Evento salvo junto da operação, enviado depois do commit            |
| Retry / exponential backoff   | Repete falha transitória com espera crescente e limite              |
| DLQ                           | Guarda mensagens inválidas/tentativas esgotadas para investigação   |
| Crash recovery                | Recupera trabalho persistido após encerramento abrupto              |
| Graceful shutdown             | Para novos trabalhos e termina/cancela o ativo com segurança        |
| Producer / consumer           | Quem envia / quem recebe/processa                                   |
| Message                       | Envelope versionado com identidade; não é a transação financeira    |
| ACK                           | DeleteMessage depois do commit; se falhar, mensagem pode voltar     |
| Visibility timeout            | Tempo em que uma mensagem recebida fica oculta                      |
| Redelivery                    | Nova entrega após falta de ACK/expiração da visibilidade            |

## Defesa das decisões

| Decisão           | Problema/motivo                                | Sem ela / trade-off                                     | Prova                                       |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Decimal + NUMERIC | Centavos exatos em todas as camadas            | Float arredonda; exige strings/validação                | Money e persistência                        |
| Lock por wallet   | Duas BET de 80 não podem gastar saldo 100      | Race/lost update; wallet disputada serializa            | Concorrência: saldo 20, outra wallet avança |
| Idempotência SQL  | Timeout não prova ausência de commit           | Retry duplica efeito; guardar resultado ocupa espaço    | Idempotência, 50 envios/restart             |
| Canonical hash    | Ordem JSON não altera significado              | Hash bruto pode divergir; contrato precisa ser definido | SubmitWager unitário                        |
| Inbox             | Crash depois de commit antes de ACK            | Redelivery duplica; tabela/retencão extras              | Mensageria crash/restart                    |
| Outbox            | SQL/SQS não têm commit único                   | Evento perdido/de rollback; envio pode repetir          | Mensageria publishers/rollback/crash        |
| Ledger protegido  | Saldo sozinho não explica histórico            | Sem auditoria; constraints custam escrita               | Persistência UPDATE/DELETE/TRUNCATE         |
| Pending Reference | Refund pode chegar antes da BET                | Rejeição prematura; agenda/TTL extras                   | Pending Reference integração                |
| Retry/DLQ         | Distinguir indisponibilidade de input inválido | Loop infinito; DLQ exige operação posterior             | Mensageria real                             |
| Health separado   | API viva pode estar sem dependências           | Restart não resolve banco; probe custa consultas        | Health outage real                          |

## Demonstração

1. Execute infraestrutura/migrations/filas/API conforme README.
2. Abra `100.00`, envie BET `25.00`, repita mesma chave e mostre `75.00` com um DEBIT.
3. Mesma chave com outro valor: 409. BET acima do saldo: 422/failureCode.
4. Consulte ledger e reconciliation; explique OPENING na soma.
5. Rode `bun test test/integration/concurrency.spec.ts --timeout 30000`; explique três processos e locks observados no PostgreSQL.
6. Mostre `test:load`, ambiente/percentis e diferença entre replay e efeito financeiro.
7. Mostre health/metrics/OpenAPI/dashboard se extras ligados.
8. Explique limites: sem auth, eventos ao menos uma vez, carga local, sem partidas dobradas.

Para cada escolha responda: qual problema, por que esta solução, o que aconteceria sem ela, qual custo e qual teste comprova. O roteiro prepara a apresentação; dominar a explicação é sua etapa de estudo.

## Decisões para explicar na apresentação

- FAILED significa falha técnica permanente demonstrada; cinco retries não provam permanência. HTTP 502 comunica resultado terminal, enquanto 503 permite retry com a mesma chave.
- Auditoria da falha ocorre depois do rollback financeiro, em nova transação. Inbox e Outbox entram juntas nesse commit; falha no commit deixa a origem recuperável.
- Uma falha de envio à DLQ não pode virar ACK na redelivery: a Inbox pula o callback e o consumer consulta o resultado original para retomar o envio.
- walletVersion identifica a mudança de saldo; FIFO e publishers concorrentes não substituem deduplicação e tratamento de eventos antigos no consumidor.
- O teste com histórico maior mede o custo da soma do ledger e uma publicação SQS mais lenta. Uma experiência local curta não prova capacidade de produção.

## Explicar a Outbox com lease

1. Reservar com token e prazo no banco; confirmar o commit.
2. Enviar ao SQS sem manter conexão SQL ocupada.
3. Confirmar publicação somente se token e prazo ainda forem válidos.
4. Em crash, esperar o prazo vencer para outra instância retomar o mesmo eventId.

O token impede escrita por um dono antigo, mas não desfaz uma mensagem que já chegou ao broker. Por isso a garantia continua sendo entrega ao menos uma vez, com deduplicação pelo consumidor. O teste com pool de uma conexão mostra que uma consulta continua atendida enquanto o envio está bloqueado. Os processadores compartilham as etapas transacionais, mantendo suas regras financeiras legíveis.
