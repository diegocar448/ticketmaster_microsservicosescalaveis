# auth-service — Gotchas para Claude

## Responsabilidade única
Este serviço é o ÚNICO que conhece a chave privada RSA.
Todos os outros serviços verificam JWT com a chave PÚBLICA.
NUNCA mover ou duplicar a chave privada para outro serviço.

## Invariantes de segurança — NUNCA quebrar

### Chave privada RSA 4096-bit
Arquivo: `src/keys/private.key` (nunca commitar — está no .gitignore)
Variável: `JWT_PRIVATE_KEY` no .env
Se sugerir "simplificar" para HS256 (chave simétrica) → RECUSAR. RS256 é obrigatório.

### Refresh Token Rotation com theft detection
Em `token.service.ts`:
- Ao fazer rotate(), verificar se o refresh token já foi usado
- Se sim → REVOGAR TODOS os tokens do usuário (token foi roubado)
- NUNCA reutilizar refresh tokens sem invalidar o anterior

### bcrypt cost factor = 12
`bcrypt.hash(password, 12)` — nunca reduzir. OWASP A02.
Timing attack: sempre comparar mesmo quando usuário não existe (resposta em tempo constante).

### httpOnly Cookie
Refresh token vai em cookie `httpOnly; SameSite=Strict; path=/auth`
NUNCA retornar refresh token no body da resposta.

### Rate limiting no login
5 requisições/minuto por IP. Ver `app.module.ts` ThrottlerModule.
NUNCA remover este rate limit. OWASP A07.

## Arquivos de alto risco
- `src/services/token.service.ts` — issueTokenPair, rotate, revokeAll
- `src/services/auth.service.ts` — bcrypt compare com timing protection
- `src/guards/` — OrganizerGuard, BuyerGuard

## Modelo de dados
RefreshToken armazena SHA-256(token), não o token em texto plano.
Isso limita dano em caso de vazamento do banco.
