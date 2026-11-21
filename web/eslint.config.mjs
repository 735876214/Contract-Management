import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 前端静态门禁（2026-11-21 质量评估 P1-2），与服务端同一套口径：
 * - `no-explicit-any` 关掉（存量 any 见 TODO，开着只会逼人写 disable）
 * - `no-unused-vars` 记 warning，用 `--max-warnings` 冻结存量
 * - 不跑格式化规则（样式看 DESIGN.md，格式看 tsc/vite）
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', navigator: 'readonly',
        console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', ResizeObserver: 'readonly', HTMLElement: 'readonly',
        HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly', HTMLDivElement: 'readonly',
        File: 'readonly', Blob: 'readonly', URL: 'readonly', Image: 'readonly', requestAnimationFrame: 'readonly',
      },
    },
    rules: {
      // 既有代码写得非常勤：`useEffect` 依赖就是 bug 源头，这条只记 warning 并用 --max-warnings 冻结
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true }],
      'no-useless-assignment': 'off',
      'no-undef': 'off',
    },
  },
);
