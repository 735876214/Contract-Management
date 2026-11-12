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
  INVOICE_TERMINAL_STATUSES,
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
    assert.deepEqual([...INVOICE_TERMINAL_STATUSES].sort(), [...INVOICE_EXCLUDED_STATUSES].sort());
    for (const s of Object.values(INVOICE_STATUS)) {
      assert.equal(
        feIsInvoiceTerminalStatus(s),
        isInvoiceTerminalStatus(s),
        `前端终态判断与后端不一致：${s}`,
      );
    }
  });

  it('六处金额聚合都接了 countedInvoiceWhere（防止新增聚合漏口径）', () => {
    const consumers: Array<[string, number]> = [
      // [文件, 至少出现次数（import + 各调用点）]
      ['../src/modules/settlement/settlement.service.ts', 3], // computeLedgerAutoFields + refreshLedger
      ['../src/modules/ledger/ledger.service.ts', 2],
      ['../src/modules/contract/contract-fulfillment.service.ts', 2],
      ['../src/modules/dashboard/dashboard.service.ts', 3], // overview + invoiceStats.byType
      ['../src/modules/ai/field-resolver.service.ts', 2],
      ['../src/modules/ai/report.service.ts', 2],
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
  });

  it('AI 两处私有谓词已收敛到共享实现', () => {
    for (const file of ['../src/modules/ai/analysis/scm-facts.ts', '../src/modules/ai/anomaly/rules-payment.ts']) {
      const src = read(file);
      assert.ok(src.includes('isCountedInvoiceStatus'), `${file} 未使用共享谓词 isCountedInvoiceStatus`);
      assert.ok(!/function\s+isCountedInvoice\s*\(/.test(src), `${file} 仍有私有 isCountedInvoice 实现`);
    }
  });
});
