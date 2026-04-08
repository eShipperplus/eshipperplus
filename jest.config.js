'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testTimeout: 15000,
  verbose: true,
  collectCoverageFrom: ['server.js'],
  coverageReporters: ['text', 'lcov'],
};
