// eslint-svelte.mjs
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

let svelteConfig;
try {
  svelteConfig = (await import('./svelte.config.js')).default;
} catch {
  svelteConfig = undefined;
}

export default [
  ...svelte.configs.recommended,

  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.js', '*.mjs'], // allows w/o a tsconfig
          defaultProject: './tsconfig.json', // fallback if no tsconfig found
        },
        extraFileExtensions: ['.svelte'],
        parser: ts.parser,
        svelteConfig,
      },
    },
    rules: {
      'svelte/no-at-html-tags': 'warn',
      'svelte/no-unused-svelte-ignore': 'error',
      'svelte/valid-compile': 'error',
      'no-undef': 'off',
    },
  },
];
