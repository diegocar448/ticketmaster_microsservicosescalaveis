#!/bin/sh
# .github/branch-protection.sh
#
# Configura Branch Protection Rules na main via GitHub CLI (gh).
#
# Pré-requisitos:
#   1. gh instalado: https://cli.github.com
#   2. Autenticado:  gh auth login
#   3. Repositório já criado no GitHub
#
# Uso:
#   GITHUB_REPO=seu-usuario/showpass sh .github/branch-protection.sh
#   ou:
#   make github-setup GITHUB_REPO=seu-usuario/showpass

set -e

REPO="${GITHUB_REPO:?Defina GITHUB_REPO=owner/repo}"
BRANCH="main"

echo "Configurando branch protection para: $REPO/$BRANCH"

# gh api usa a REST API do GitHub com o token do 'gh auth login'
# Documentação: https://docs.github.com/en/rest/branches/branch-protection
gh api \
  --method PUT \
  "repos/$REPO/branches/$BRANCH/protection" \
  --field "required_status_checks[strict]=true" \
  --field "required_status_checks[contexts][]=Lint & Type Check" \
  --field "required_status_checks[contexts][]=Unit Tests" \
  --field "enforce_admins=true" \
  --field "required_pull_request_reviews[required_approving_review_count]=1" \
  --field "required_pull_request_reviews[dismiss_stale_reviews]=true" \
  --field "required_pull_request_reviews[require_code_owner_reviews]=true" \
  --field "restrictions=null" \
  --field "allow_force_pushes=false" \
  --field "allow_deletions=false" \
  --field "block_creations=false" \
  --field "required_conversation_resolution=true" \
  --field "lock_branch=false"

echo ""
echo "Branch protection configurada com sucesso!"
echo ""
echo "Regras ativas em $REPO/$BRANCH:"
echo "  [x] Status checks obrigatórios antes de merge:"
echo "      - Lint & Type Check"
echo "      - Unit Tests"
echo "  [x] Branch deve estar atualizada antes de merge (strict)"
echo "  [x] Mínimo 1 aprovação de Pull Request"
echo "  [x] Reviews stale são descartadas ao novo push"
echo "  [x] Code Owner review obrigatório (ver .github/CODEOWNERS)"
echo "  [x] Conversas devem ser resolvidas antes de merge"
echo "  [x] Force push bloqueado (protege histórico)"
echo "  [x] Deleção da branch bloqueada"
echo "  [x] Regras aplicadas mesmo para admins (enforce_admins)"
