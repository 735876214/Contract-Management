import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * 全仓 ESLint（flat config）。**不是**类型检查的替代，只做「代码检查器能稳定判定」的部分：
 * - 语法级正确性（不可达代码、重复键、var、debugger）；
 * - **本仓特有的两处口径**（用 no-restricted-syntax 表达，报错文案直接给修法）：
 *   ① 金额/数量展示只能走 `web/src/utils/money.ts`（禁止裸 `toLocaleString`）；
 *   ② 列表日期区间只能走 `common/calc/time` 的 `startOfDay/endOfDay`（禁止 `new Date(query.endDate)`）；
 * - React Hooks 规则（`rules-of-hooks` = error 会直接抓到条件调用 hook 的崩溃级问题）。
 *
 * **刻意不做的事**（都在 TODO.md 里登记了原因）：
 * - 不开类型感知规则（`no-floating-promises` 等）：需要 projectService，全仓 460+ 文件跑一遍要
 *   一两分钟，且存量会先报一批；等第 3 批把 API 类型补上后再单独开。
 * - `@typescript-eslint/no-explicit-any` 暂为 off：全仓 2000+ 处 any，一次性开等于把闸门关掉。
 *   已在 `docs/development.md` 写明「新增代码不要新增 any」的纪律。
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'server/prisma/migrations/**',
      'server/src/common/services/cscec-logo.base64.ts',
      'server/src/modules/final-settlement/final-settlement-template.ts',
      '*.js',
      '*.mjs',
    ],
  },

  // ---------------- 通用（server / web / mcp） ----------------
  {
    files: ['server/src/**/*.ts', 'server/test/**/*.{ts,mts}', 'server/scripts/**/*.{ts,mts}', 'web/src/**/*.{ts,tsx}', 'mcp/**/*.{ts,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'no-var': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ---------------- TypeScript ----------------
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['server/src/**/*.ts', 'server/test/**/*.{ts,mts}', 'web/src/**/*.{ts,tsx}', 'mcp/**/*.{ts,js}'],
  })),
  {
    files: ['server/src/**/*.ts', 'server/test/**/*.{ts,mts}', 'server/scripts/**/*.{ts,mts}', 'web/src/**/*.{ts,tsx}', 'mcp/**/*.{ts,js}'],
    rules: {
      // 存量口径（见文件头）：暂不强制
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      // 真问题才报：未使用变量（下划线前缀是刻意占位）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
    },
  },

  // ---------------- React Hooks（web） ----------------
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // 条件/循环里调 hook = 崩溃级，必须拦住（这条全仓当前是干净的）
      'react-hooks/rules-of-hooks': 'error',
      // 依赖数组：存量有 50 处 eslint-disable 抑制，先按 warn 观测，不阻断 CI
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // ---------------- 本仓特有的两条口径 ----------------
  {
    files: ['web/src/**/*.{ts,tsx}'],
    ignores: ['web/src/utils/money.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='toLocaleString']",
          message:
            '金额/数量展示统一用 @/utils/money 的 formatAmount / formatMoney / formatNumber（它统一了空值占位与小数位）；时间戳展示用 formatDateTime。',
        },
      ],
    },
  },
  {
    files: ['server/src/modules/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name='endDate']",
          message:
            "日期区间右边界用 common/calc/time 的 endOfDay(endDate)，或 lt: nextDayStart(endDate)：new Date('YYYY-MM-DD') 按 UTC 解析（本地 08:00），会把当天 00:00 之后的记录漏掉。",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name='startDate']",
          message: '日期区间左边界用 common/calc/time 的 startOfDay(startDate)（本地零点，非 UTC）。',
        },
      ],
    },
  },

  // ---------------- 允许 console 的入口 ----------------
  {
    files: [
      'server/src/main.ts',
      'server/src/seed.ts',
      'server/src/seed-data.ts',
      'server/scripts/**/*.{ts,mts}',
    ],
    rules: { 'no-console': 'off' },
  },
);
