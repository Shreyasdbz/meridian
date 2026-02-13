import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import-x';

/** Modules that each component is allowed to import from (via @meridian/* aliases). */
const MODULE_DEPS = {
  shared: [],
  axis: ['shared'],
  scout: ['shared'],
  sentinel: ['shared'],
  journal: ['shared'],
  gear: ['shared'],
  bridge: ['shared'],
};

/**
 * Build no-restricted-imports patterns for a given module.
 * Prevents importing from @meridian/* modules that are not in the allow-list,
 * and prevents importing internal files from other modules (must go through index.ts).
 */
function buildRestrictedImports(moduleName) {
  const allowed = MODULE_DEPS[moduleName] ?? [];
  const allModules = Object.keys(MODULE_DEPS);
  const forbidden = allModules.filter((m) => m !== moduleName && !allowed.includes(m));

  const patterns = [];

  // Block disallowed @meridian/* imports
  for (const mod of forbidden) {
    patterns.push({
      name: `@meridian/${mod}`,
      message: `Module '${moduleName}' cannot depend on '${mod}'. Allowed: [${allowed.join(', ')}].`,
    });
  }

  // Block cross-module internal file imports (must go through index.ts barrel)
  for (const mod of allModules) {
    if (mod === moduleName) continue;
    patterns.push({
      name: `../src/${mod}/*`,
      message: `Import from '@meridian/${mod}' instead of reaching into internal files.`,
    });
    patterns.push({
      name: `../../${mod}/*`,
      message: `Import from '@meridian/${mod}' instead of reaching into internal files.`,
    });
  }

  return patterns;
}

/**
 * Additional restrictions for sentinel: cannot import journal (information barrier).
 * Intentionally duplicates the buildRestrictedImports() entry to provide a more
 * descriptive error message highlighting the security-critical information barrier.
 */
const SENTINEL_EXTRA = [
  {
    name: '@meridian/journal',
    message:
      'Sentinel cannot access Journal (information barrier). Sentinel must not see user messages, Journal data, or Gear catalog.',
  },
];

/** Axis cannot import LLM provider SDKs. */
const AXIS_LLM_PATTERNS = [
  { name: 'openai', message: 'Axis must have no LLM dependency.' },
  { name: '@anthropic-ai/sdk', message: 'Axis must have no LLM dependency.' },
  { name: 'ollama', message: 'Axis must have no LLM dependency.' },
  { name: '@google/generative-ai', message: 'Axis must have no LLM dependency.' },
];

export default tseslint.config(
  // Global ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**', 'coverage/**', '*.config.*'],
  },

  // Base TypeScript config for all files
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importPlugin,
    },
    rules: {
      // TypeScript strict rules
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // Relax some strict rules that are too noisy for this project
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Import ordering
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [
            {
              pattern: '@meridian/**',
              group: 'internal',
              position: 'before',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/newline-after-import': 'error',
      'import-x/no-duplicates': 'error',

      // General best practices
      'no-console': 'warn',
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },

  // Module boundary rules: shared/
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: buildRestrictedImports('shared'),
        },
      ],
    },
  },

  // Module boundary rules: axis/
  {
    files: ['src/axis/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...buildRestrictedImports('axis'), ...AXIS_LLM_PATTERNS],
        },
      ],
    },
  },

  // Module boundary rules: scout/
  {
    files: ['src/scout/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: buildRestrictedImports('scout'),
        },
      ],
    },
  },

  // Module boundary rules: sentinel/
  {
    files: ['src/sentinel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...buildRestrictedImports('sentinel'), ...SENTINEL_EXTRA],
        },
      ],
    },
  },

  // Module boundary rules: journal/
  {
    files: ['src/journal/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: buildRestrictedImports('journal'),
        },
      ],
    },
  },

  // Module boundary rules: gear/
  {
    files: ['src/gear/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: buildRestrictedImports('gear'),
        },
      ],
    },
  },

  // Module boundary rules: bridge/
  {
    files: ['src/bridge/**/*.ts', 'src/bridge/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: buildRestrictedImports('bridge'),
        },
      ],
    },
  },

  // React/TSX specific rules
  {
    files: ['src/bridge/ui/**/*.tsx'],
    rules: {
      // Allow non-explicit return types in React components
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // Test file overrides
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      'no-console': 'off',
    },
  },
);
