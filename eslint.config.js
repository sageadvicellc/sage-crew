import tseslint from 'typescript-eslint';

const homeMessage =
  'Read the home folder through src/env.ts only, so tests can hand every module a fixture home.';

const homeBan = {
  'no-restricted-properties': [
    'error',
    { object: 'os', property: 'homedir', message: homeMessage },
  ],
  'no-restricted-imports': [
    'error',
    {
      paths: [
        { name: 'os', importNames: ['homedir'], message: homeMessage },
        { name: 'node:os', importNames: ['homedir'], message: homeMessage },
      ],
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.name='HOME']",
      message: homeMessage,
    },
    {
      selector:
        "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='env'][property.value='HOME']",
      message: homeMessage,
    },
    {
      selector:
        "VariableDeclarator[init.type='MemberExpression'][init.object.name='process'][init.property.name='env'] > ObjectPattern > Property[key.name='HOME']",
      message: homeMessage,
    },
  ],
};

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      ...homeBan,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The one reader of the home folder, and the test setup that builds the
    // temp home and guards it.
    files: ['src/env.ts', 'test/setup/**'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
