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
  // Mapear imports com extensão .js para .ts — NodeNext usa .js em imports
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
};
