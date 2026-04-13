# Skill: Criar Migration Prisma

## Regras invioláveis

1. **NUNCA editar arquivos em `prisma/migrations/`** — são imutáveis após aplicados em produção
2. **NUNCA usar `prisma migrate reset` em produção** — destrói dados
3. **SEMPRE testar a migration em dev antes de commitar**

## Fluxo correto

```bash
# 1. Editar o schema.prisma do serviço
# apps/{service}/prisma/schema.prisma

# 2. Criar a migration (dev)
pnpm --filter @showpass/{service}-service run db:migrate:dev
# Isso cria: prisma/migrations/{timestamp}_{nome}/migration.sql

# 3. Revisar o SQL gerado ANTES de commitar
cat apps/{service}/prisma/migrations/{timestamp}_{nome}/migration.sql

# 4. Verificar se a migration é destrutiva
# ⚠️  DROP TABLE, DROP COLUMN → dados perdidos
# ⚠️  ALTER TABLE ADD COLUMN NOT NULL sem DEFAULT → falha em produção se há dados
# ✅  ADD COLUMN NULL → seguro
# ✅  CREATE INDEX CONCURRENTLY → seguro (não bloqueia tabela)

# 5. Para colunas NOT NULL em tabelas existentes:
#    Passo 1: ADD COLUMN nullable
#    Passo 2: UPDATE com valor padrão
#    Passo 3: ALTER COLUMN SET NOT NULL
#    (fazer em 3 migrations separadas se tabela tiver dados)

# 6. Aplicar em produção (CI faz isso automaticamente)
pnpm --filter @showpass/{service}-service run db:migrate
```

## Checklist antes de commitar

- [ ] SQL gerado revisado manualmente
- [ ] Sem operações destrutivas não intencionais
- [ ] Índices adicionados para colunas usadas em WHERE/JOIN
- [ ] Migration testada localmente com `db:migrate:dev`
- [ ] `prisma generate` rodou (tipos atualizados)
