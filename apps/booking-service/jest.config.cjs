module.exports = {
  displayName: '@showpass/booking-service',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.spec.json',
      // useESM não é necessário — tsconfig.spec.json compila para CommonJS
      // (evita incompatibilidade com o jest runner)
      useESM: false,
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  // Apenas unit tests (src/**/*.spec.ts)
  testMatch: ['**/?(*.)+(spec).ts?(x)'],
  // Mapear imports com extensão .js para .ts (NodeNext usa .js) E os packages
  // workspace para o src direto — sem isso o unit test não resolve @showpass/*
  // num checkout limpo (CI), onde os dist/ dos packages ainda não foram buildados.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@showpass/types/nest$': '<rootDir>/../../packages/types/src/decorators/current-user.decorator.ts',
    '^@showpass/types$': '<rootDir>/../../packages/types/src/index.ts',
    '^@showpass/redis$': '<rootDir>/../../packages/redis/src/index.ts',
    '^@showpass/kafka$': '<rootDir>/../../packages/kafka/src/index.ts',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
};
