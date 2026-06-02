// Security-focused ESLint configuration for MaminHleb_bot
// Run: npx eslint --config eslint.config.security.js bot/
// Install: npm install --save-dev eslint @eslint/js eslint-plugin-security eslint-plugin-no-secrets

import js from '@eslint/js';
import security from 'eslint-plugin-security';
import noSecrets from 'eslint-plugin-no-secrets';

export default [
  js.configs.recommended,
  security.configs.recommended,
  {
    plugins: {
      security,
      'no-secrets': noSecrets,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        process:   'readonly',
        console:   'readonly',
        Buffer:    'readonly',
        __dirname: 'readonly',
        require:   'readonly',
        module:    'readonly',
        exports:   'readonly',
        setTimeout:   'readonly',
        clearTimeout: 'readonly',
        setInterval:  'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      // ── Injection & Dangerous APIs ─────────────────────────────────────────
      'no-eval':         'error',
      'no-implied-eval': 'error',
      'no-new-func':     'error',
      'no-script-url':   'error',

      // ── Security Plugin ────────────────────────────────────────────────────
      'security/detect-object-injection':          'warn',
      'security/detect-non-literal-fs-filename':   'error',
      'security/detect-eval-with-expression':      'error',
      'security/detect-non-literal-regexp':        'warn',
      'security/detect-possible-timing-attacks':   'error',
      'security/detect-pseudoRandomBytes':         'error',
      'security/detect-buffer-noassert':           'error',
      'security/detect-child-process':             'error',
      'security/detect-disable-mustache-escape':   'error',
      'security/detect-new-buffer':                'error',
      'security/detect-non-literal-require':       'warn',
      'security/detect-unsafe-regex':              'error',

      // ── Secrets Detection ──────────────────────────────────────────────────
      'no-secrets/no-secrets': ['error', { tolerance: 4.5 }],

      // ── General Quality ────────────────────────────────────────────────────
      'no-unused-vars':   ['warn', { argsIgnorePattern: '^_' }],
      'no-debugger':      'error',
    },
    ignores: ['node_modules/**'],
  },
];
