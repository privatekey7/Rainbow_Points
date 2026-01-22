import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { 
        project: ['./tsconfig.json'],
        ecmaVersion: 'latest',
        sourceType: 'module'
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly'
      }
    },
    plugins: { 
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      // Standard style rules
      'indent': ['error', 2],
      'quotes': ['error', 'single'],
      'semi': ['error', 'never'],
      'no-trailing-spaces': 'error',
      'eol-last': 'error',
      'comma-dangle': ['error', 'never'],
      'space-before-function-paren': ['error', 'always'],
      'keyword-spacing': 'error',
      'space-infix-ops': 'error',
      'object-curly-spacing': ['error', 'always'],
      'array-bracket-spacing': ['error', 'never'],
      'computed-property-spacing': ['error', 'never'],
      'func-call-spacing': ['error', 'never'],
      'key-spacing': 'error',
      'no-multiple-empty-lines': ['error', { 'max': 1 }],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  },
  {
    ignores: [
      'dist/',
      'node_modules/',
      '**/*.d.ts',
      'Rainbow-Chrome/**',
      'Captain_Badge/**',
      '**/*.js.map',
      '**/*.css.map',
      '**/*.woff2',
      '**/*.png',
      '**/*.svg',
      '**/*.mp3',
      '**/*.json'
    ]
  }
]
