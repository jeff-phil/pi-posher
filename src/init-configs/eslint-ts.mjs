import ts from 'typescript-eslint';

export default [
  ...ts.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx,mts,cts}'],
  })),

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
];
