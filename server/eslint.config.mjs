import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 服务端静态门禁（2026-11-21 质量评估 P1-2）。
 *
 * 目标：**挡住新缺陷**，不与既有代码的写法吵架。所以：
 * - `no-explicit-any` 关掉：存量 `any` 约 1400 处（见 TODO 的「存量 any 收口」），
 *   开着只会逼人写 `eslint-disable`，反而把真问题淹掉。
 * - `no-unused-vars` 记 warning 并用 `--max-warnings` 冻结存量：只减不增。
 * - `no-require-imports` 关掉：`html-to-docx` / `pngjs` 没有类型声明，必须 require。
 * - 格式化规则一条都不开：格式由 `nest build` / 代码风格约定把关，不在这里纠。
 *
 * 真正**当 error** 的是这几类「几乎一定是 bug」的：console 残留、未定义变量、
 * 重复 import、无用的表达式语句、不可达代码、无效的 eslint-disable。
 */
export default tseslint.config(
  { ignores: ['dist/**', 'prisma/migrations/**', 'node_modules/**', 'eslint.probe.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 服务端不允许裸 console.log（业务日志走 LogService / Logger）；warn/error 放行
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // 中文排版里的全角空格（U+3000）是有意的（Excel/日志文案「A　B」），只在代码位置算问题
      'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipTemplates: true }],
      // 先 `let x = null` 再按分支赋值是可读性选择，不是 bug；真正的「未赋值」由 strict tsc 兜住
      'no-useless-assignment': 'off',
    },
  },
  {
    /**
     * 本仓特有口径（2026-11-22 质量审计）：列表日期区间只能用 `common/calc/time` 的本地日原语。
     * `new Date('YYYY-MM-DD')` 按 **UTC** 解析（本地 08:00），库里存本地 00:00 的记录会被漏掉；
     * 全仓曾有 7 处这么写，另有手拼 'T23:59:59' 与就地 setHours 两种写法，已统一。
     */
    files: ['src/modules/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name='endDate']",
          message:
            "日期区间右边界用 common/calc/time 的 endOfDay(endDate)，或 lt: nextDayStart(endDate)：new Date('YYYY-MM-DD') 按 UTC 解析（本地 08:00），会漏掉当天记录。",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name='startDate']",
          message: '日期区间左边界用 common/calc/time 的 startOfDay(startDate)（本地零点，非 UTC）。',
        },
      ],
    },
  },
  {
    // 启动播种脚本是 CLI 语义，输出本来就走 stdout
    files: ['src/seed.ts', 'src/seed-data.ts'],
    rules: { 'no-console': 'off' },
  },
);
