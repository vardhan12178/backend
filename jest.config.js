export default {
    testEnvironment: 'node',
    transform: {},
    verbose: true,
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.js'],
    coveragePathIgnorePatterns: ['/node_modules/'],
    testTimeout: 30000,
    setupFilesAfterEnv: ['<rootDir>/tests/setupDB.js']
  };
  