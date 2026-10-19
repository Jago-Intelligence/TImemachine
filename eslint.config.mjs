import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '.timemachine/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.next/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!zod$|\\.)',
              message: 'Core may import only Zod and its own relative modules.',
            },
            {
              group: ['../../*'],
              message: 'Core must not import another workspace package by relative path.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/sdk-node/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@timemachine/core$|zod$|typescript$|node:|\\.)',
              message:
                'The Node.js SDK may import only core, Zod, TypeScript, Node.js and its own modules.',
            },
            {
              group: ['../../*'],
              message:
                'The SDK must not import another workspace package by relative path.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
