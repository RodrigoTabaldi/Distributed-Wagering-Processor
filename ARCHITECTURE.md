# Arquitetura implementada

Descrição do estado atual; documentos 03/04 preservam o planejamento. O enunciado 01 prevalece sobre extras opcionais.

## Camadas e fluxo

`domain/`: Money, Wallet, transações, ledger e envelopes, sem Nest/ORM. `application/`: casos de uso e ports (contratos). `infrastructure/`: PostgreSQL, SQS, telemetria/workers. `interfaces/`: validação HTTP/SQS. Providers do Nest conectam implementações aos contratos via injeção de dependência.

HTTP → DTO → SubmitWager → UnitOfWork → lock wallet → identidade persistida → operação → wallet/transação/ledger/Outbox → commit → resposta.

MikroORM foi escolhido para integrar TypeScript, EntityManager isolado e transações/migrations explícitas. Entidades de persistência são separadas das classes do domínio e mappers convertem entre ambas. SQL explícito permanece onde locks, CAS, agregações e constraints precisam de controle preciso; o ORM não substitui essas garantias. O custo é manter mappers e conhecer o comportamento transacional do driver.

SQS → envelope/provedor → Inbox + mesmo SubmitWager na mesma sessão → commit → ACK. Publisher seleciona Outbox confirmada numa transação separada, envia e marca publicada. Crash após envio e antes dessa marca pode repetir o mesmo eventId.

## Dinheiro e integridade

Money valida strings com duas casas, moeda reconhecida e limite `999999999999999999.99`, usa configuração própria decimal.js e não transforma dinheiro em number. Persistência usa `NUMERIC(20,2)`. Entradas negativas, expoentes, NaN, overflow e escala incorreta são rejeitados. Resultados internos negativos servem à reconciliação; Wallet impede saldo negativo.

Ledger registra valor positivo com direção CREDIT/DEBIT, wallet/transação, saldos anterior/posterior e data. Abertura positiva produz OPENING/CREDIT; abertura zero não produz movimento. LOSS e valores zero não alteram saldo/versão nem criam ledger. Rejeição não movimenta. REFUND credita uma BET processada; ROLLBACK inverte BET/WIN/REFUND, com failureCode próprio para débito inverso sem saldo.

Migrations 001–004 definem CHECK, FK, UNIQUE de player/moeda/chave/provider-externalId, unicidade parcial de reversões, imutabilidade de resultados terminais e triggers contra UPDATE/DELETE/TRUNCATE do ledger. Constraints diferidas conferem saldo = SUM(CREDIT) − SUM(DEBIT) e coerência transação/lançamento no commit. Uma falha desfaz todas as gravações da UnitOfWork. Reversão de migrations é comprovada em schemas descartáveis; não deve apagar auditoria de produção.

ReconciliationReader consulta uma fotografia SQL com todos os lançamentos, inclusive OPENING. Informa diferença/consistência sem correção automática. Paginação usa cursor estável `(created_at,id)`, microssegundos, vínculo à wallet e limite máximo 100.

## Concorrência e idempotência

`FOR UPDATE` serializa somente alterações da mesma wallet, antes da checagem de saldo. Outras wallets seguem em paralelo. Cada UnitOfWork usa EntityManager isolado; todos os repositories compartilham a mesma sessão. Versão/CAS protege contra escrita desatualizada; UNIQUE arbitra identidades entre instâncias. Não há mutex de processo como garantia financeira.

SubmitWager normaliza UUID/Money, seleciona campos de negócio, ordena chaves recursivamente, serializa canonical JSON e calcula SHA-256. Hash identifica conteúdo divergente, não criptografa. Header/datas/correlação/IDs gerados ficam fora do hash. Chave e identidade externa são persistidas, assim como o saldo observado e resultado original de replay, mesmo após novas movimentações/restart.

Identidade é consultada antes e depois do lock. Uma corrida UNIQUE causa rollback e consulta do vencedor numa nova transação. Mesma chave com payload diferente, ou outra chave para a mesma identidade externa, retorna 409. Replays não alteram saldo/ledger.

## Mensageria e falhas

Inbox deduplica `(consumerName,messageId)`, compara hash e confirma processamento no mesmo commit financeiro. Crash após commit antes de ACK gera redelivery seguro. Mensagens distintas para a mesma operação ainda passam pela idempotência de negócio; FIFO sozinho não basta.

Outbox guarda envelope imutável/eventId/correlação/data/agenda de retry. `FOR UPDATE SKIP LOCKED` permite publishers concorrentes em eventos diferentes. Somente eventos confirmados podem ser enviados. Não há commit distribuído SQL/SQS: entrega é ao menos uma vez com eventId estável; consumidores externos precisam de deduplicação. O envio mantém o lock Outbox durante I/O, solução simples que ocupa conexão e exige medir capacidade.

FIFO agrupa por wallet, long polling 20s, visibilidade 30s e heartbeat 10s. Falhas transitórias usam backoff 1,2,4…60s, até cinco recebimentos. Permanentes vão à DLQ; origem só é apagada após envio à DLQ ou commit/ACK. Falha de ACK mantém reentrega recuperável. A política do SDK não substitui o retry da aplicação.

Pending Reference persiste REFUND/ROLLBACK sem origem, sem efeito antecipado. Worker limita backoff a 60s, 20 tentativas ou TTL 30min; verifica dependências sob lock e processa quando possível. Esgotamento rejeita com failureCode. Restart não perde agenda.

## Shutdown e observabilidade

Nest recebe sinais com `enableShutdownHooks`. Workers param novos polls e aguardam trabalho ativo até 10s; se necessário cancelam SQL e esperam rollback antes de devolver visibilidade. ACK só após commit. Publishers interrompidos são repetíveis. Clientes/pool são fechados depois dos workers. Windows simula sinal onde não há semântica POSIX; Docker verifica SIGTERM Linux real.

Liveness verifica processo; readiness verifica banco e três filas com prazo aproximado de 2s. Falha runtime produz 503, mantém liveness e recupera quando a dependência volta. Banco indisponível desde startup impede inicialização do ORM.

Logs JSON usam uma lista permitida de IDs/status/source; não contêm saldo/payload/chave/hash/SQL/credenciais. Métricas têm labels pequenos, sem IDs, e registram transições, duplicatas, retries, DLQ, conflitos SQL/CAS, divergência, duração e Outbox lag. Eventos financeiros são contados após commit. Contadores são locais, reiniciam com o processo e precisam de Prometheus para agregação.

OpenTelemetry opcional exporta spans HTTP/SQL/SQS por OTLP HTTP. AsyncLocalStorage mantém parentesco local e traceId/spanId nos logs. Sem auto-instrumentação de todos os drivers nem propagação W3C externa. Dashboard provisionado usa Prometheus; traces são consultados diretamente na UI do Jaeger. Grafana 12.1 usa a API legada do Jaeger no seu datasource, incompatível com a configuração padrão do Jaeger 2.21; por isso não provisionamos essa integração. As ferramentas são locais e efêmeras. `/metrics` depende de SQL para consultar o lag real.

## Autenticação e HTTP

Autenticação foi omitida conforme opção do desafio. DemoAuthGuard é explicitamente permissivo: não valida identidade. ProviderIdentityPort define futura integração OIDC com IdP como Keycloak/Zitadel, validando assinatura/JWKS, issuer, audience e expiração. Também será necessário autorizar providerId/acesso à wallet; JWT validado sozinho não resolve autorização. `@Public` marca health/OpenAPI para a futura substituição do guard. Não criamos usuários/senhas caseiros. SQS valida allowlist; implantação AWS exige IAM/políticas adequadas.

HTTP: 201 wallet criada; 200 sucesso/replay; 202 referência pendente; 400 input; 404 consulta ausente; 409 conflito; 422 rejeição financeira; 503 infraestrutura transitória; 500 inesperado. `infrastructureHttpError` centraliza erros técnicos sem detalhes do driver. Pipes/404 mantêm formato padrão Nest; onde aplicável, códigos de negócio/infraestrutura são estáveis. Contrato em OpenAPI/README.

## Trade-offs e limites

- Wallet disputada fica serializada; segurança financeira tem prioridade sobre throughput dessa wallet.
- Triggers/constraints e soma do ledger adicionam custo por commit; histórico grande exige medir e desenhar checkpoints auditáveis antes de otimizar.
- FIFO não substitui Inbox nem evita todas as referências fora de ordem entre produtores.
- Outbox pode entregar eventos duplicados; consumidores externos precisam deduplicar.
- Sem autenticação, rate limiting, gestão produtiva de secrets, deploy cloud ou SLA nesta demonstração.
- Banco local usa proprietário para migrations/testes; produção deve separar usuário de migration/runtime para impedir bypass administrativo de triggers.
- Ledger por wallet está implementado; partidas dobradas/contas de contrapartida são extras não implementados.
- Carga local curta usa uma API/oito conexões, HTTP e publisher SQS real; não prevê capacidade produtiva. Multiprocesso/crash é verificado separadamente.

Evidências: [docs/evaluation.md](docs/evaluation.md). Execução: [README.md](README.md).
