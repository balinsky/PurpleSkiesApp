/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: true, types: ['jest'] } }],
  },
  moduleNameMapper: {
    '^expo-sqlite$': '<rootDir>/__mocks__/expo-sqlite.ts',
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^xlsx-js-style$': '<rootDir>/__mocks__/xlsx-js-style.ts',
    '^expo-file-system/legacy$': '<rootDir>/__mocks__/expo-file-system.ts',
  },
};
