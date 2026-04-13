// jest.preset.js — Configuração compartilhada do Jest para todos os pacotes
// O preset fornece defaults comuns a todos os apps: ts-jest, tsconfig, collectCoverage, etc.
// Cada app estende este arquivo em seu jest.config.js passando preset: '../../jest.preset.js'

module.exports = {
  testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  globals: {
    'ts-jest': {
      isolatedModules: true,
    },
  },
};
