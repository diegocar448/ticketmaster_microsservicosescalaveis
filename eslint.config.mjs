// eslint.config.mjs — ESLint v9 flat config
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import security from 'eslint-plugin-security';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  security.configs.recommended, // OWASP A03: detecta injection patterns
  prettier,
  {
    // projectService: true → typescript-eslint v8 descobre o tsconfig.json mais próximo
    // de cada arquivo automaticamente (sem precisar listar caminhos manualmente).
    // tsconfigRootDir aponta para a raiz do monorepo para resolução correta.
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Forçar uso de tipos explícitos em retornos de funções públicas
      '@typescript-eslint/explicit-function-return-type': 'error',

      // Proibir 'any' — use 'unknown' e faça type narrowing
      '@typescript-eslint/no-explicit-any': 'error',

      // Garantir que Promises sejam sempre awaited ou void-cast
      '@typescript-eslint/no-floating-promises': 'error',

      // Proibir non-null assertion (!) — tratar nullability explicitamente
      '@typescript-eslint/no-non-null-assertion': 'error',

      // Segurança: não usar regex dinâmico (ReDoS)
      'security/detect-non-literal-regexp': 'error',
    },
  },
  {
    // Ignorar arquivos gerados automaticamente
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/prisma/generated/**',
    ],
  },
);
