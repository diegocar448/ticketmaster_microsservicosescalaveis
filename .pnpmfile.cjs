// .pnpmfile.cjs — Hooks para pnpm resolver dependências e vulnerabilidades
// Fornece overrides de versões para patches de segurança

module.exports = {
  hooks: {
    readPackage(pkg) {
      // OWASP A06: atualizar tar para versão sem vulnerabilidades conhecidas
      // bcrypt@5.1.1 depende de @mapbox/node-pre-gyp que usa tar@6.2.1
      // Forçar tar para >=7.5.11 (última versão segura)
      if (pkg.dependencies?.tar || pkg.devDependencies?.tar) {
        if (!pkg.dependencies) pkg.dependencies = {};
        pkg.dependencies.tar = '>=7.5.11';
      }

      return pkg;
    },
  },
};
