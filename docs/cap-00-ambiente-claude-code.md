# Capítulo 0 — Ambiente Claude Code

> **Objetivo:** configurar o ambiente de desenvolvimento assistido por IA antes de escrever
> uma linha de código. Este capítulo é pré-requisito para todos os outros — a estrutura
> aqui criada guia, protege e automatiza o desenvolvimento ao longo dos 18 capítulos.

---

## Por que configurar antes de codar?

Claude Code é o CLI oficial da Anthropic que roda diretamente no terminal. Diferente de
um chatbot, ele tem acesso ao sistema de arquivos, executa comandos e edita código.

Isso cria dois comportamentos possíveis:

```
Sem configuração:          Com configuração:
  Claude decide sozinho      Claude segue suas regras
  Contexto reinicia a        Contexto persiste entre
  cada sessão                sessões (memória)
  Sem guardrails             Invariantes aplicadas
  Dívida técnica acumula     Padrões enforçados
```

A configuração é feita em arquivos `.md` e `.json` — documentos que o Claude lê
automaticamente antes de qualquer ação. É como um onboarding escrito para a IA.

---

## Estrutura que vamos criar

```
showpass/
├── CLAUDE.md                    ← instruções globais do projeto
├── .claude/
│   ├── settings.json            ← permissões e comportamento do CLI
│   ├── skills/                  ← workflows reutilizáveis
│   │   ├── new-service.md       ← como criar um microserviço
│   │   ├── prisma-migration.md  ← como criar uma migration
│   │   └── code-review.md       ← checklist de revisão
│   └── hooks/                   ← automações (verificações automáticas)
│       └── post-tool-use.sh     ← roda após edições de arquivo
└── apps/
    └── <serviço>/
        └── CLAUDE.md            ← gotchas específicos do serviço
```

---

## Passo 0.1 — CLAUDE.md raiz

O `CLAUDE.md` na raiz do projeto é o **primeiro arquivo lido** pelo Claude Code em toda
sessão. Ele define o porquê do projeto, o mapa do repositório, as regras obrigatórias e
os guardrails — coisas que não devem ser feitas sem confirmação explícita.

### Estrutura de um CLAUDE.md eficaz

Um CLAUDE.md bem escrito tem três seções:

```markdown
# Nome do Projeto — Instruções para Claude Code

## Por que este projeto existe (PORQUÊ)
Contexto de negócio. Qual problema resolve. Qual é a audiência.
Uma IA sem contexto de negócio toma decisões puramente técnicas que podem
ser corretas em teoria e erradas para o seu produto.

## Mapa do repositório (O QUÊ)
Onde cada coisa vive. Estrutura de diretórios. Principais módulos.
Poucos parágrafos — o suficiente para orientar sem virar documentação.

## Regras de funcionamento (COMO)
Stack com versões fixas (evitar sugestões de downgrade).
Padrões obrigatórios (idioma, comentários, biblioteca preferida).
Guardrails: o que NUNCA fazer sem confirmação explícita.
```

### CLAUDE.md do ShowPass (criado na raiz)

```markdown
# ShowPass — Instruções para Claude Code

## Por que este projeto existe (PORQUÊ)

Tutorial em pt-BR de um clone do Ticketmaster em nível de big tech.
O problema central: 300.000 pessoas tentam comprar o mesmo assento ao mesmo tempo.
A solução: Redis SETNX atômico — operação que torna double booking impossível.

Audiência: engenheiros seniores pt-BR. Código sempre com comentários explicando o PORQUÊ.

## Mapa do repositório (O QUÊ)

apps/         NestJS microservices (api-gateway, auth, event, booking, payment, search, worker)
packages/     Shared libs (types/Zod, kafka, redis)
infra/        K8s manifests, Terraform, Docker configs
docs/         18-chapter tutorial + ADRs + runbooks + architecture
CLAUDE.md     ← este arquivo

Cada apps/<service>/ tem seu próprio CLAUDE.md com os "gotchas" daquele serviço.

## Regras de funcionamento (COMO)

### Stack (versões fixas — não sugerir downgrades)
- Node.js 22 LTS · NestJS 11 · Prisma 7 · Next.js 16.2
- TypeScript 6.0 · Zod 4 · Stripe SDK 22
- PostgreSQL 18 · Redis 8.6 · Elasticsearch 9.3 · Kafka 4.2

### Padrões obrigatórios
- Idioma: todo código, comentários e prosa em pt-BR
- Comentários: explicar o PORQUÊ, nunca o O QUÊ (o código já diz o quê)
- Repository pattern: controllers nunca importam PrismaService diretamente
- Tenant isolation: toda query passa organizerId — nunca consultar sem filtro
- OWASP: anotar inline qual mitigação cada bloco implementa (A01–A10)

### Guardrails — NUNCA fazer sem confirmação
- Alterar arquivos em prisma/migrations/ (histórico imutável)
- Fazer git push --force ou kubectl delete em qualquer contexto
- Remover ou alterar packages/redis/src/redis.service.ts (Lua scripts críticos)
```

> **Regra de ouro do CLAUDE.md:** seja específico no COMO, não no O QUÊ. "Use Zod 4"
> é uma regra. "Crie um schema de validação" é uma instrução que pertence ao código.

---

## Passo 0.2 — .claude/settings.json

O `settings.json` controla o comportamento do CLI: quais ferramentas o Claude pode
usar sem pedir permissão, quais são sempre bloqueadas, e configurações globais.

### Criando o arquivo

```bash
mkdir -p .claude
touch .claude/settings.json
```

### Estrutura mínima para o ShowPass

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm *)",
      "Bash(docker compose *)",
      "Bash(git status)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(curl -s *)",
      "Bash(make *)"
    ],
    "deny": [
      "Bash(git push --force*)",
      "Bash(kubectl delete*)",
      "Bash(rm -rf*)",
      "Bash(DROP TABLE*)"
    ]
  }
}
```

**Por que lista de permissões explícita?**

Sem ela, toda vez que Claude quiser rodar `pnpm install`, o terminal pergunta se você
autoriza. Com ela, comandos pré-aprovados rodam automaticamente — apenas ações
destrutivas ou irreversíveis ainda pedem confirmação.

### Regra prática

```
allow  → comandos rotineiros de desenvolvimento (build, test, start)
deny   → ações irreversíveis em infra ou dados (force push, drop, rm -rf)
```

---

## Passo 0.3 — .claude/skills/

Skills são arquivos Markdown com checklists e instruções para tarefas repetitivas.
São invocados explicitamente via `/skills` ou referenciados no CLAUDE.md.

**Analogia:** uma skill é um "manual de procedimentos" para uma tarefa específica.
Em vez de o Claude improvisar cada vez que você pede "crie um novo serviço", ele
segue o mesmo checklist validado — resultado consistente em todas as sessões.

### Criando o diretório

```bash
mkdir -p .claude/skills
```

### Skills do ShowPass

O projeto usa três skills. Cada uma é invocada quando o contexto se aplica:

**`.claude/skills/new-service.md`** — invocado ao criar um microserviço

```markdown
# Skill: Adicionar Novo Serviço NestJS ao Monorepo

## 1. Estrutura de diretórios
mkdir -p apps/{nome}-service/src/{modules,common/{filters,pipes,guards},prisma}

## 2. Arquivos obrigatórios
- src/main.ts           → bootstrap com Helmet, CORS, ValidationPipe
- src/app.module.ts     → AppModule
- src/prisma/           → PrismaService com driver adapter (Prisma 7)
- CLAUDE.md             → gotchas específicos do serviço

## 3. Atualizar
- docker-compose.yml     → adicionar serviço
- apps/api-gateway/      → adicionar rota de proxy
- Makefile               → adicionar ao db-migrate
- .github/ci.yml         → adicionar ao matrix de build
```

**`.claude/skills/prisma-migration.md`** — invocado ao alterar o schema

```markdown
# Skill: Criar Migration Prisma

## Invariantes
- NUNCA editar arquivos em prisma/migrations/ (histórico imutável)
- SEMPRE gerar migration com nome descritivo em snake_case
- Verificar se a migration é reversível antes de aplicar em produção

## Passos
1. Editar schema.prisma
2. pnpm --filter @showpass/<serviço> prisma:migrate -- --name <descricao>
3. Verificar o SQL gerado em prisma/migrations/<timestamp>_<nome>/
4. Testar rollback localmente antes de commitar
```

**`.claude/skills/code-review.md`** — invocado ao revisar código gerado

```markdown
# Skill: Code Review — ShowPass

## Segurança (OWASP)
- [ ] A01: toda query passa organizerId? (tenant isolation)
- [ ] A02: passwords via bcrypt cost 12?
- [ ] A07: rate limiting em endpoints de login?
- [ ] A10: webhook Stripe valida HMAC antes de processar?

## Padrões
- [ ] Controllers não importam PrismaService diretamente
- [ ] Zod 4: z.uuid(), z.url(), z.email() (não z.string().uuid())
- [ ] Kafka consumer tem checagem de idempotência
- [ ] Comentários em pt-BR explicando o PORQUÊ
```

> **Dica:** Skills são descobertos via `/skills` no terminal Claude Code ou invocados
> automaticamente quando você descreve a tarefa (ex: "adicione um novo serviço X").

---

## Passo 0.4 — .claude/hooks/

Hooks são scripts shell executados automaticamente em resposta a eventos do Claude Code:
antes de rodar uma ferramenta, depois de editar um arquivo, antes de fazer commit.

**Analogia:** Git hooks, mas para ações da IA. Se Claude editar um `.ts`, o hook pode
rodar o type-check automaticamente — você só vê o resultado, sem precisar pedir.

### Criando o hook de verificação pós-edição

```bash
mkdir -p .claude/hooks
```

Crie `.claude/hooks/post-edit.sh`:

```bash
#!/usr/bin/env bash
# Hook: roda após Claude editar qualquer arquivo TypeScript.
# Objetivo: capturar erros de tipo antes que o desenvolvedor perceba.

FILE="$1"  # arquivo editado (passado pelo Claude Code)

# Só verificar arquivos TypeScript
if [[ "$FILE" != *.ts && "$FILE" != *.tsx ]]; then
  exit 0
fi

# Detectar qual serviço foi editado
if [[ "$FILE" == apps/auth-service/* ]]; then
  FILTER="@showpass/auth-service"
elif [[ "$FILE" == apps/event-service/* ]]; then
  FILTER="@showpass/event-service"
elif [[ "$FILE" == apps/booking-service/* ]]; then
  FILTER="@showpass/booking-service"
elif [[ "$FILE" == apps/web/* ]]; then
  FILTER="@showpass/web"
else
  exit 0  # serviço não mapeado — não bloquear
fi

echo "→ type-check em $FILTER..."
pnpm --filter "$FILTER" run type-check --noEmit 2>&1 | grep "error TS" | head -5
```

Tornar executável:

```bash
chmod +x .claude/hooks/post-edit.sh
```

Registrar no `settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": ".claude/hooks/post-edit.sh"
          }
        ]
      }
    ]
  }
}
```

**Resultado prático:** se Claude editar `auth.controller.ts` e introduzir um erro de tipo,
você vê imediatamente `error TS2345: Argument of type 'string'...` — sem ter que rodar
`type-check` manualmente.

---

## Passo 0.5 — CLAUDE.md por serviço

Cada microserviço tem seu próprio `CLAUDE.md` em `apps/<serviço>/CLAUDE.md`.

**Por que por serviço?** Cada serviço tem invariantes únicas que um CLAUDE.md global
não consegue cobrir sem ficar enorme. O auth-service nunca deve mudar de RS256 para HS256.
O booking-service nunca deve quebrar o all-or-nothing dos locks Redis. Essas regras só
fazem sentido no contexto de cada serviço.

### Quando criar

**Criar junto com o serviço** — antes de escrever a primeira linha de código.
O CLAUDE.md documenta as decisões de design enquanto elas ainda estão frescas.

### Estrutura padrão

```markdown
# <nome>-service — Gotchas para Claude

## Responsabilidade única
Uma frase: o que este serviço faz. Uma frase: o que ele NÃO faz.
Isso previne "scope creep" — Claude não vai adicionar lógica
de pagamento no auth-service porque o CLAUDE.md diz que ele não faz isso.

## Invariantes críticas — NUNCA quebrar
Lista de regras com exemplos de código.
Cada item responde: "O que acontece se eu quebrar isso?"

## Arquivos de alto risco
Os 2-4 arquivos que, se modificados descuidadamente, quebram o serviço.
Claude vai ler esses arquivos antes de propor qualquer mudança neles.

## Dependências externas
Quais outros serviços, bancos ou brokers este serviço usa.
Ajuda a entender o impacto de uma mudança antes de fazê-la.
```

### Exemplo real: booking-service

```markdown
# booking-service — Gotchas para Claude

## Responsabilidade única
Reserva ingressos com garantia de exclusão mútua via Redis SETNX.
NÃO processa pagamentos (isso é o payment-service).

## Invariantes críticas — NUNCA quebrar

### TTL do lock = 7 minutos
LOCK_TTL_SECONDS = 7 * 60 em seat-lock.service.ts
RESERVATION_TTL_MINUTES = 7 em reservations.service.ts
Os dois DEVEM ser iguais — lock expira quando reserva expira.

### All-or-nothing em acquireMultiple()
Se N assentos solicitados e 1 falha → TODOS os locks adquiridos são liberados.
NUNCA retornar sucesso parcial: comprador não pode ficar com locks de outros.

## Arquivos de alto risco
- src/modules/locks/seat-lock.service.ts     → núcleo anti-double-booking
- src/modules/reservations/reservations.service.ts → fluxo de 6 passos
```

---

## Resumo: o que cada arquivo faz

```
CLAUDE.md (raiz)
  └─ "Quem somos, o que fazemos, como fazemos"
     Lido em toda sessão. Define o tom e as regras globais.

.claude/settings.json
  └─ "O que Claude pode fazer sem perguntar"
     Permissões automáticas vs. confirmação obrigatória.

.claude/skills/
  └─ "Como fazer tarefas recorrentes"
     Checklists para não improvisar a cada sessão.

.claude/hooks/
  └─ "Verificações automáticas após ações"
     Guardrails em tempo real (type-check, lint, testes).

apps/<serviço>/CLAUDE.md
  └─ "O que não pode ser quebrado neste serviço"
     Invariantes específicas, arquivos de risco, gotchas descobertos.
```

---

## Testando na prática

Após criar os arquivos, verifique que o Claude Code os reconhece:

```bash
# 1. Iniciar o Claude Code na raiz do projeto
claude

# 2. Verificar que o CLAUDE.md foi carregado
# Claude deve mencionar "ShowPass" ou as regras do projeto ao ser invocado

# 3. Testar uma skill
# Digite: /skills
# Deve listar: new-service, prisma-migration, code-review

# 4. Verificar permissões
# Tente pedir: "rode pnpm install"
# Deve executar sem pedir confirmação (está no allow do settings.json)

# 5. Verificar guardrails
# Tente pedir: "faça git push --force"
# Claude deve recusar ou pedir confirmação explícita
```

---

## Recapitulando

1. **CLAUDE.md raiz** — contexto de negócio + regras globais + guardrails. Lido automaticamente em toda sessão.
2. **settings.json** — permissões de ferramentas. Separa o que é rotina (allow) do que é destrutivo (deny).
3. **skills/** — checklists para tarefas recorrentes. Resultado consistente sem depender da memória do Claude.
4. **hooks/** — automações pós-ação. Type-check rodando sem você pedir é melhor do que descobrir erro depois.
5. **CLAUDE.md por serviço** — invariantes específicas. Criado junto com o serviço, atualizado quando invariantes mudam.

A estrutura toda é texto simples — sem dependências, sem instalação, versionada no git.
Qualquer engenheiro que clonar o repo e abrir o Claude Code recebe exatamente o mesmo
contexto que você tem agora.

---

## Próximo capítulo

Com o ambiente Claude Code configurado, vamos criar a estrutura do monorepo pnpm e
os pacotes compartilhados que todos os microserviços vão usar.

→ **[Capítulo 1 — Ambiente e Monorepo](cap-01-ambiente-monorepo.md)**
