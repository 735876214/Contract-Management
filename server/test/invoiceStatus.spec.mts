import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INVOICE_STATUS,
  INVOICE_EXCLUDED_STATUSES,
  countedInvoiceWhere,
  isInvoiceTerminalStatus,
  isCountedInvoiceStatus,
} from '../src/constants/statuses.ts';
import {
  INVOICE_STATUS as FE_INVOICE_STATUS,
  INVOICE_EXCLUDED_STATUSES as FE_INVOICE_EXCLUDED_STATUSES,
  isInvoiceTerminalStatus as feIsInvoiceTerminalStatus,
} from '../../web/src/constants/invoiceStatus.ts';

/**
 * 发票作废/红冲口径锁（业务口径 2026-11-12）。
 *
 * 「作废（CANCELLED）/ 红冲（RED）不计入金额口径」必须**只有一份实现**：
 * - DB 查询走 `countedInvoiceWhere()`（显式纳入 NULL，避免 SQL 三值逻辑静默漏行）；
 * - 内存过滤走 `isCountedInvoiceStatus()`；
 * - 前端列表动作/编辑表单的终态判断走 `web/src/constants/invoiceStatus.ts`（本文件锁 parity）。
 *
 * 同时扫描六处金额聚合点，防止未来新增聚合时漏接过滤（台账「本月开票额」是发货最痛的一处）。
 */

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(here(rel), 'utf8');
const countOf = (src: string, needle: string) => src.split(needle).length - 1;

describe('发票终态口径（作废/红冲）', () => {
  it('排除清单恰为 CANCELLED/RED，且是 INVOICE_STATUS 的子集', () => {
    assert.deepEqual([...INVOICE_EXCLUDED_STATUSES].sort(), [
      INVOICE_STATUS.CANCELLED,
      INVOICE_STATUS.RED,
    ].sort());
    const all = new Set(Object.values(INVOICE_STATUS));
    for (const s of INVOICE_EXCLUDED_STATUSES) assert.ok(all.has(s as any), `${s} 不在 INVOICE_STATUS 中`);
  });

  it('countedInvoiceWhere() 显式纳入 NULL（不用 NOT），与 paidPaymentWhere 同款', () => {
    assert.deepEqual(countedInvoiceWhere(), {
      OR: [{ statusCode: null }, { statusCode: { notIn: INVOICE_EXCLUDED_STATUSES } }],
    });
    assert.ok(!('NOT' in countedInvoiceWhere()), '不能用 NOT：SQL 三值逻辑会把 NULL 行静默排除');
  });

  it('内存谓词与 DB 片段同口径：null/未填计入，终态不计入', () => {
    assert.equal(isCountedInvoiceStatus(null), true);
    assert.equal(isCountedInvoiceStatus(undefined), true);
    assert.equal(isCountedInvoiceStatus(INVOICE_STATUS.VERIFIED), true);
    assert.equal(isCountedInvoiceStatus(INVOICE_STATUS.CANCELLED), false);
    assert.equal(isCountedInvoiceStatus(INVOICE_STATUS.RED), false);

    assert.equal(isInvoiceTerminalStatus(INVOICE_STATUS.CANCELLED), true);
    assert.equal(isInvoiceTerminalStatus(INVOICE_STATUS.RED), true);
    assert.equal(isInvoiceTerminalStatus(INVOICE_STATUS.VERIFIED), false);
    assert.equal(isInvoiceTerminalStatus(null), false);
  });

  it('前后端镜像一致（状态取值与终态清单逐条相等）', () => {
    assert.deepEqual(Object.values(FE_INVOICE_STATUS).sort(), Object.values(INVOICE_STATUS).sort());
    assert.deepEqual([...FE_INVOICE_EXCLUDED_STATUSES].sort(), [...INVOICE_EXCLUDED_STATUSES].sort());
    for (const s of Object.values(INVOICE_STATUS)) {
      assert.equal(
        feIsInvoiceTerminalStatus(s),
        isInvoiceTerminalStatus(s),
        `前端终态判断与后端不一致：${s}`,
      );
    }
  });

  it('各金额聚合都接了 countedInvoiceWhere（含 query 层统一口径）', () => {
    const consumers: Array<[string, number]> = [
      // [文件, 至少出现次数（import + 各调用点）]
      ['../src/modules/settlement/settlement.service.ts', 3], // computeLedgerAutoFields + refreshLedger
      // 台账的发票聚合已收进查询层（2026-11-23），service 本身不再直查表
      ['../src/query/ledger-queries.ts', 2], // loadLedgerContractFacts
      ['../src/modules/contract/contract-fulfillment.service.ts', 2],
      // 工作台的发票金额聚合已收进查询层（2026-11-23），service 本身不再直查表
      ['../src/query/dashboard-queries.ts', 3], // loadOverviewTotals + loadInvoiceStatsGroups
      ['../src/query/ai-fact-queries.ts', 2], // AI 读取层的 loadInvoiceFacts 统一接口径
      ['../src/modules/ai/analytics/dataset-collector.service.ts', 3], // 发票记录 + 履约/台账聚合
    ];
    for (const [file, min] of consumers) {
      const src = read(file);
      assert.ok(
        countOf(src, 'countedInvoiceWhere') >= min,
        `${file} 的发票金额聚合未接 countedInvoiceWhere（期望 ≥${min} 处）`,
      );
      assert.ok(
        !src.includes('NOT: { statusCode'),
        `${file} 出现 NOT: { statusCode } —— SQL 三值逻辑会静默排除空状态发票`,
      );
    }

    // AI 侧不再各自写 prisma.invoice，统一走 loadInvoiceFacts({ excludeTerminal: true })
    for (const file of [
      '../src/modules/ai/field-resolver.service.ts',
      '../src/modules/ai/report.service.ts',
      '../src/modules/ai/analytics/dataset-collector.service.ts',
    ]) {
      const src = read(file);
      assert.ok(src.includes('loadInvoiceFacts'), `${file} 未通过 query 层的 loadInvoiceFacts 统计开票额`);
      assert.ok(
        src.includes('excludeTerminal: true'),
        `${file} 调用 loadInvoiceFacts 时未显式 excludeTerminal: true（作废/红冲会混入）`,
      );
    }

    // 窗口事实必须完全走 query 层：这两个文件里出现 prisma.invoice 就是绕过口径
    // （dataset-collector 的明细行查询是域特有的，不在本条约束内）
    for (const file of [
      '../src/modules/ai/field-resolver.service.ts',
      '../src/modules/ai/report.service.ts',
    ]) {
      const src = read(file);
      assert.ok(
        !src.includes('prisma.invoice'),
        `${file} 直接出现 prisma.invoice —— 发票口径必须走 query 层的 loadInvoiceFacts`,
      );
    }
  });

  it('AI 两处谓词收敛到 ai/common/invoice-facts（该文件因此有生产调用）', () => {
    for (const file of ['../src/modules/ai/analysis/scm-facts.ts', '../src/modules/ai/anomaly/rules-payment.ts']) {
      const src = read(file);
      assert.ok(src.includes('invoice-facts'), `${file} 未使用 AI 侧共享谓词 isCountedInvoice（invoice-facts）`);
      assert.ok(!/function\s+isCountedInvoice\s*\(/.test(src), `${file} 仍有私有 isCountedInvoice 实现`);
    }
  });
});
