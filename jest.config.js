const nextJest = require('next/jest')

const createJestConfig = nextJest({ dir: './' })

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'node',
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/.next/'],
  collectCoverageFrom: [
    'lib/**/*.{js,jsx}',
    'app/**/*.{js,jsx}',
    '!app/**/layout.js',
    '!app/**/page.js',
  ],
}

module.exports = createJestConfig(config)
