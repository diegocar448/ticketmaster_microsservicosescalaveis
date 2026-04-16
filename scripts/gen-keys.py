#!/usr/bin/env python3
"""
scripts/gen-keys.py
-------------------
Gera par de chaves RSA 4096-bit e grava nos arquivos .env no formato correto.

Por que Python e não shell/awk?
- O awk 'printf "%s\\n"' gera newlines reais, que o dotenv trata como fim de valor.
- Dotenv converte \\n (literal) → newline APENAS para valores entre aspas duplas.
- Python garante o formato "JWT_PRIVATE_KEY=\"...\\n...\"" de forma portável.
"""

import subprocess
import re
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def run(cmd):
    subprocess.run(cmd, shell=True, check=True)

# Gerar par de chaves RSA 4096-bit
run("openssl genrsa -out /tmp/showpass_private.pem 4096 2>/dev/null")
run("openssl rsa -in /tmp/showpass_private.pem -pubout -out /tmp/showpass_public.pem 2>/dev/null")

# Ler e converter para single-line com \\n literal
with open("/tmp/showpass_private.pem") as f:
    private_key = "\\n".join(line for line in f.read().splitlines() if line.strip())

with open("/tmp/showpass_public.pem") as f:
    public_key = "\\n".join(line for line in f.read().splitlines() if line.strip())

# Limpar arquivos temporários
os.unlink("/tmp/showpass_private.pem")
os.unlink("/tmp/showpass_public.pem")

def update_env(path: str, key: str, value: str) -> None:
    """
    Atualiza KEY=... no arquivo .env, removendo eventuais valores multiline
    gerados por versões antigas do gen-keys.
    O valor é gravado como: KEY="...\\n..." (aspas duplas + \\n literal)
    Dotenv interpreta \\n dentro de aspas duplas como newline real.
    """
    if not os.path.exists(path):
        return

    with open(path) as f:
        lines = f.readlines()

    result = []
    skip = False
    for line in lines:
        # Detecta início do key em questão
        if line.startswith(f"{key}="):
            result.append(f'{key}="{value}"\n')
            skip = True
            continue
        # Continua pulando linhas que são continuação do valor multiline:
        # linhas que NÃO começam com UPPER_CASE_VAR= nem com # nem linha em branco
        if skip:
            stripped = line.rstrip()
            # Nova variável: começa com letra maiúscula/underscore seguida de = sem espaços
            is_new_var = bool(re.match(r'^[A-Z_][A-Z0-9_]*=', stripped))
            is_comment = stripped.startswith('#')
            is_blank = stripped == ''
            if is_new_var or is_comment or is_blank:
                skip = False
            else:
                continue  # pula linha de continuação do valor multiline
        result.append(line)

    with open(path, "w") as f:
        f.writelines(result)

    print(f"  ✓ {path}")

# Atualizar auth-service (chave privada + pública)
update_env(os.path.join(ROOT, "apps/auth-service/.env"), "JWT_PRIVATE_KEY", private_key)
update_env(os.path.join(ROOT, "apps/auth-service/.env"), "JWT_PUBLIC_KEY", public_key)

# Distribuir chave pública para os outros serviços
for svc in ["api-gateway", "booking-service", "payment-service",
            "search-service", "worker-service", "web"]:
    path = os.path.join(ROOT, f"apps/{svc}/.env")
    update_env(path, "JWT_PUBLIC_KEY", public_key)

print("✅ Chaves RSA geradas e distribuídas para todos os serviços")
