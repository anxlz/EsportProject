import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      'apps/api/drizzle/**',
      '**/next-env.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Test helpers read loosely-typed JSON responses.
      '@typescript-eslint/no-explicit-any': 'off',
      // NestJS uses decorator metadata on constructor parameter types.
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-syntax': [
        'error',
        {
          // Spec §3.2: never authorize by role name; check permission keys instead.
          selector:
            'BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name=/^(nameEn|nameAr|templateKey)$/]',
          message: 'Do not branch on role names or template keys; check a permission key instead.',
        },
      ],
    },
  },
  {
    // Tests may look up seeded default roles by template key; production code may not.
    files: ['**/test/**', '**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
