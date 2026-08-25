// scaffolding: espressivo's rule set, pointed at mpmify's layout, so the 155 findings the
// move has to clear surface here rather than after it.
//
// what is deliberately NOT here: espressivo's LAYER_ZONES and `import/no-cycle`. those encode
// espressivo's L0-L7 fences, which mean nothing in a standalone tree, and both need
// eslint-plugin-import + eslint-import-resolver-typescript, neither of which is installed.
// they land at the move.
//
// prettierConfig stays last so it can switch off anything that would fight the formatter.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'node_modules/**',
      'coverage/**',
      // fixtures are inputs, not source
      'test/fixtures/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,

  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // `x == null` is TypeScript's correct test for "null or undefined" and stays.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',

      '@typescript-eslint/no-unused-vars': 'error',

      // exported API states its return type; inference is fine internally.
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      '@typescript-eslint/prefer-for-of': 'error',

      // warn, not error, outside src/: the transformers have a documented mutation boundary.
      'no-param-reassign': 'warn',
    },
  },

  {
    // espressivo spells this `tests/`. renamed at the move; here it is `test/`.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // --- type-aware, src/ only ---
  //
  // these ten need `parserOptions.projectService`, which is what makes them work and what makes
  // them slow. scoped to src/ exactly as espressivo scopes it; test/ and scripts/ keep the
  // cheap syntactic parse. projectService picks tsconfig.json for src/ and
  // tsconfig.tests.json for the rest, so both must exist before this config runs.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/prefer-reduce-type-parameter': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      'no-param-reassign': 'error',
    },
  },

  // a library does not narrate to stdout. scripts/ may; src/ may not.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error'] }],
    },
  },

  prettierConfig,
);
