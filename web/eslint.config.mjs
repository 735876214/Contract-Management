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
  {
    /**
     * 本仓特有口径（2026-11-22 质量审计）：金额/数量展示只能走 `@/utils/money`。
     * 无参数的 `toLocaleString('zh-CN')` 会把 JS 浮点原样吐出（后端求和后的 1234.5600000000001），
     * 带参数的则有 7 种组合，同一笔金额在不同页面显示成 ¥1,234.50 / 1,234.00 / 1,234。
     */
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/utils/money.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toLocaleString']",
          message:
            '金额/数量展示统一用 @/utils/money 的 formatAmount / formatMoney / formatNumber；时间戳用 formatDateTime。',
        },
        {
          // 2026-11-28：与服务端同款规则。纯日期字段（*.startDate / *.endDate / *.signDate …）
          // 用 new Date(x) 解析走的是 **UTC**，浏览器时区不是 +08:00 时会回退一天，
          // 而这串日期常直接印在正式单据上。格式化走 @cms/calc/time 的 formatDay / localDayKey。
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name=/Date$/]",
          message:
            '纯日期字段别用 new Date(x.xxxDate)：按 UTC 解析，非 +08:00 时区会回退一天。用 @cms/calc/time 的 formatDay / startOfDay / endOfDay。',
        },
      ],
    },
  },
);
