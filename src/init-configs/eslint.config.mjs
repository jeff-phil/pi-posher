import eslintConfigPrettier from 'eslint-config-prettier';
import * as noUnsanitized from 'eslint-plugin-no-unsanitized';
import * as security from 'eslint-plugin-security';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';

// --- HELPER TO DYNAMICALLY LOAD OPTIONAL CONFIGS ---
async function loadOptionalConfig(modulePath) {
  try {
    const mod = await import(modulePath);
    // Safely handle both single config objects and arrays of config objects
    return Array.isArray(mod.default) ? mod.default : [mod.default];
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.log(`ℹ️ [ESLint] INFO: Skipping ${modulePath} (file not found)`);
      return []; // Return empty array so it spreads safely
    }
    throw err; // Re-throw real errors (like syntax errors in the config)
  }
}

// Fetch the configs (if they don't exist, they just return empty arrays)
const jsConfig = await loadOptionalConfig('./eslint-js.mjs');
const tsConfig = await loadOptionalConfig('./eslint-ts.mjs');
const svelteConfig = await loadOptionalConfig('./eslint-svelte.mjs');

// --- MAIN EXPORT ---
export default [
  // Global Ignores
  {
    ignores: ['{node_modules,dist,build,.svelte-kit,npm-global,npm,.local}/**'],
  },

  // Drop in the dynamically loaded configs above
  ...jsConfig,
  ...tsConfig,
  ...svelteConfig,

  // 3. Main Shared Configuration
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,svelte}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
      security,
      'no-unsanitized': noUnsanitized,
    },
    rules: {
      // --- IMPORT SORTING ---
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',

      'no-unused-vars': 'off', // Must be off for unused-imports plugin to work
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
        },
      ],

      // Shared logic rules
      'no-console': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // Prettier must always be last to override styling rules
  eslintConfigPrettier,
];
