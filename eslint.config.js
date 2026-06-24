const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const prettierPlugin = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const security = require('eslint-plugin-security');
const sonarjs = require('eslint-plugin-sonarjs');

// security/sonarjs ship their rules at "error". We surface them as advisory
// "warn" instead: the lint gate stays green (CI runs without --max-warnings),
// findings still show in the log, and rules can be ratcheted to error over time.
const toWarn = (rules) =>
  Object.fromEntries(
    Object.entries(rules)
      // Only downgrade rules the preset actually enables — never flip an
      // intentionally-"off" rule on (that's how 800+ style warnings creep in).
      .filter(([, level]) => level !== 'off' && level !== 0)
      .map(([rule]) => [rule, 'warn']),
  );

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'src/generated/**', '.eslintrc.js'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
      globals: {
        afterAll: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        console: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        jest: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: prettierPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unnecessary-type-constraint': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  // Advisory security / bug-pattern layer (eslint-plugin-security + sonarjs).
  {
    files: ['**/*.ts'],
    plugins: { security, sonarjs },
    rules: {
      ...toWarn(security.configs.recommended.rules),
      ...toWarn(sonarjs.configs.recommended.rules),
      // Off — high false-positive rate in this codebase:
      'security/detect-object-injection': 'off', // fires on every obj[key]
      'sonarjs/no-clear-text-protocols': 'off', // hits http:// in comments/examples
      'sonarjs/assertions-in-tests': 'off', // pactum fluent asserts not recognized
      'sonarjs/cognitive-complexity': 'off', // subjective; revisit later
      'sonarjs/todo-tag': 'off', // TODOs are tracked elsewhere
    },
  },
];
