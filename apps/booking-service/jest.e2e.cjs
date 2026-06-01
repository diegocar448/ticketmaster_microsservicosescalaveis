// Carrega o .env do booking-service antes de qualquer test.
// O AppModule lê REDIS_PASSWORD, DATABASE_URL etc. de process.env.
// Sem isso o Redis rejeita conexões com "NOAUTH Authentication required".
require('dotenv').config({ path: __dirname + '/.env' });

module.exports = {
  displayName: '@showpass/booking-service (e2e)',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.spec.json',
      useESM: false,
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  testMatch: ['**/test/e2e/**/*.e2e-spec.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@showpass/types/nest$': '<rootDir>/../../packages/types/src/decorators/current-user.decorator.ts',
    '^@showpass/types$': '<rootDir>/../../packages/types/src/index.ts',
    '^@showpass/redis$': '<rootDir>/../../packages/redis/src/index.ts',
    '^@showpass/kafka$': '<rootDir>/../../packages/kafka/src/index.ts',
  },
  testTimeout: 30000,
};
