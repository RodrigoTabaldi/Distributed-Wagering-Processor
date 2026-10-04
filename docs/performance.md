# Experimentos de carga

Comandos: `bun run test:load` e `bun run test:load:history`. Ambos usam HTTP, PostgreSQL e SQS reais, uma API e pool de oito conexões. Cada execução cria schema e filas exclusivos, verifica a reconciliação e remove suas fixtures.

A carga mede 250 requisições: 100 em wallets distintas, 100 na mesma wallet e 50 repetições de uma identidade. Isso produz 201 operações novas e 49 replays. Aquecimento de 20 requisições não entra nos percentis nem no throughput. Percentis usam nearest-rank e incluem leitura da resposta HTTP.

O segundo comando prepara 500 apostas adicionais na wallet disputada e adiciona 25 ms antes de cada envio SQS real. A preparação não entra nos percentis, mas entra na reconciliação e no backlog de eventos. Esse atraso modela publicação lenta, não uma queda completa do SQS; indisponibilidade, retry e crash são verificados pela integração.

## Interpretação

Os JSONs [load-results.json](load-results.json) e [load-history-results.json](load-history-results.json) são a fonte dos números e registram ambiente, parâmetros e instante de execução. Não são uma meta de RPS nem um benchmark de produção. Como o histórico e o atraso variam juntos, a comparação não isola o custo de cada um.

O histórico de 500 lançamentos exercita a soma do ledger, mas ainda é pequeno. Uma avaliação de crescimento precisa repetir com tamanhos crescentes e várias rodadas, mantendo as demais variáveis fixas. A mesma wallet permanece serializada por segurança financeira; throughput de replay não equivale a novos efeitos financeiros.

O pool é amostrado a cada 10 ms durante preparação, tráfego e drenagem: conexões ocupadas, pedidos aguardando e média de ocupação. A coleta usa contadores locais do driver, sem consumir conexão SQL. São picos amostrados, não máximos absolutos; pausas do processo podem atrasar a coleta. A média inclui a drenagem, portanto não representa apenas o pico HTTP.

`lockConflicts=0` significa ausência de timeout, deadlock e conflito de versão detectados. Não significa ausência de espera pelos locks. Outbox lag é a idade do evento pendente mais antigo, incluindo eventos gerados na preparação.

No experimento atual com histórico, o pool atingiu oito conexões ocupadas e houve um pedido aguardando. O atraso artificial elevou o lag amostrado para cerca de 47,63 s. Ao final, backlog e lag ficaram em zero, com saldo não negativo e igual à soma do ledger em todas as wallets.

A publicação usa duas transações curtas: reservar e confirmar. Entre elas, o envio SQS não mantém conexão SQL ocupada. A reserva persiste por 90 s e pode ser retomada após crash; token e prazo impedem que um dono antigo sobrescreva o atual. Esse desenho libera recursos durante rede lenta, mas aumenta o número de commits e pode atrasar a retomada de um crash até o lease expirar.

## Comparação local antes e depois do lease

Os resultados anteriores foram preservados em [load-before-lease-results.json](load-before-lease-results.json) e [load-history-before-lease-results.json](load-history-before-lease-results.json). A máquina, parâmetros e instante estão nos JSONs; a refatoração dos processadores também mudou nesta revisão. São execuções únicas, sem isolamento completo da máquina, portanto não permitem atribuir toda variação de latência exclusivamente aos leases.

| Experimento | Média de conexões ocupadas antes | Depois | Lag máximo antes | Depois |
| --- | ---: | ---: | ---: | ---: |
| Padrão | 3,60 | 3,21 | 4,48 s | 5,00 s |
| 500 apostas prévias + atraso SQS | 1,47 | 0,74 | 43,59 s | 47,63 s |

A média inclui períodos de preparação e drenagem com durações diferentes. O pico permaneceu em oito conexões e um pedido aguardando. A redução de ocupação média é compatível com liberar a conexão durante o envio; não demonstra aumento de throughput nem eliminação de contenção. O lag maior também deve ser considerado: duas transações por publicação têm custo.

A prova direta está no teste de integração com pool limitado a uma conexão: uma consulta completa enquanto o envio SQS fica bloqueado. Outros testes matam processos antes e depois do envio, retomam claims vencidos e recusam a confirmação de um dono antigo. Ambas as cargas terminam sem erros, com backlog zero e reconciliação financeira consistente.

O próximo experimento de capacidade deve variar histórico e atraso separadamente, repetir execuções e comparar distribuições. Se a soma do ledger dominar o commit com históricos maiores, avaliar checkpoints auditáveis com novas provas de consistência.
