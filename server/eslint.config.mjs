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
 *
 * ⚠ **必须带大栈跑**（见 package.json 的 lint script：`node --stack-size=8000 ./node_modules/eslint/bin/eslint.js`）：
 * `src/assets/cscec-logo.base64.ts` 是单行 ~89KB 的 base64 生成物，typescript-eslint 解析它的递归深度
 * 正好卡在 Node 默认栈容量的**边界**上（Node 20/24 都复现，与版本无关）：
 *   - 单独 lint 这个文件 → **稳定**抛 `Parsing error: Maximum call stack size exceeded`（8/8 次）；
 *   - 全量 lint 时 → **抖动**，同一命令可能失败也可能通过（实测首次 FAIL、随后 3 次 OK）。
 * 内容本身零 error（--stack-size=8000 下全量稳定 exit 0），所以这不是代码问题，是栈容量问题。
 * 改回裸 `eslint` 会让 CI 的 lint 门禁**随机红**；正解要么像现在这样加大栈，
 * 要么把该生成物加进下面的 ignores。
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
     * 本仓特有口径（2026-11-22 质量审计）：列表日期区间只能用 `@cms/calc/time` 的本地日原语。
     * `new Date('YYYY-MM-DD')` 按 **UTC** 解析（本地 08:00），库里存本地 00:00 的记录会被漏掉；
     * 全仓曾有 7 处这么写，另有手拼 'T23:59:59' 与就地 setHours 两种写法，已统一。
     *
     * 2026-11-24 追加：**金额/数量舍入只能走 `@cms/calc/money` 的 round2 / round4**。
     * `Number(x.toFixed(2))` 是另一套舍入（1.005 → `1`、8.165 → `8.16`，而 round2 给 1.01 / 8.17），
     * 与 `test/money.spec.ts` 锁定的口径**相反**；原先 25 处散在台账/看板/预警/文案里，
     * 已全部收敛到 calc 原语，此规则防回流。
     *
     * 适用范围从 `src/modules` 扩到整个 `src`（同样的日期写法在 query/domain/common 也出现过，
     * 只盯模块等于给别处开绿灯）。
     */
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name='endDate']",
          message:
            "日期区间右边界用 @cms/calc/time 的 endOfDay(endDate)，或 lt: nextDayStart(endDate)：new Date('YYYY-MM-DD') 按 UTC 解析（本地 08:00），会漏掉当天记录。",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.0.property.name='startDate']",
          message: '日期区间左边界用 @cms/calc/time 的 startOfDay(startDate)（本地零点，非 UTC）。',
        },
        {
          selector: "CallExpression[callee.name='Number'] > CallExpression[callee.property.name='toFixed']",
          message:
            '金额/数量舍入用 @cms/calc/money 的 round2 / round4（Number(x.toFixed(2)) 是另一套舍入：1.005 → 1、8.165 → 8.16，与 money.spec 锁定的口径相反）。',
        },
        {
          // 2026-11-28：内存里手写求和是「口径长回来的入口」——空值处理、舍入位数、
          // 选哪些字段，每个人写法都不一样。金额用 @cms/calc 的 sumAmounts（内部 num + round2），
          // 数量/比例用 @cms/calc/numeric 的 sum（不舍入）；SQL 侧走 common/utils/group-sum。
          selector: "CallExpression[callee.property.name='reduce'] CallExpression[callee.name='Number']",
          message:
            '别在 reduce 里手写 Number(...) 求和：金额走 @cms/calc 的 sumAmounts、数量/比例走 @cms/calc/numeric 的 sum（组求和走 aggregate/groupBy）。',
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
