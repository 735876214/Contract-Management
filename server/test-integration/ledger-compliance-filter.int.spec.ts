// @domains: ledger
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { LedgerService } from '../src/modules/ledger';
import { LEDGER_COMPLIANCE } from '../src/modules/ledger/ledger-compliance';

/**
 * 集成测试 · 台账「合规性问题」筛选（真库）。
 *
 * 合规性是**内存派生列**（库里没有这一列），2026-11-22 把它从「取全项目合同 + 全部附表到内存再过滤切片」
 * 改成「窄投影扫一遍算命中 id → 只回查当页完整行」。本用例钉住改造**没有改口径**：
 * ① 六种判定结果都能被对应筛选值命中，且只返回该结果的行；
 * ② `total` 是**命中条数**（不是未过滤总数），否则前端分页器会渲出空页；
 * ③ 分页切片与行号正确、跨页不重不漏，顺序与「未筛选」时一致（createdAt desc）。
 */
describe('集成 · 台账「合规性问题」筛选', () => {
  let ctx: IntContext;
  let ledger: LedgerService;

  before(async () => {
    ctx = await bootIntApp();
    ledger = ctx.get<LedgerService>(LedgerService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 造一份合同：类型/签订日期 + ext 的招标与定标 + 进场日报（三者都可缺） */
  const mk = async (
    projectId: string,
    opts: {
      typeCode: string;
      sign?: Date | null;
      bidStart?: Date | null;
      bidWin?: Date | null;
      entry?: Date | null;
    },
  ) => {
    const code = uniq('INT-LC').toUpperCase();
    const c = await ctx.prisma.contract.create({
      data: { projectId, code, name: '合规性筛选用例 ' + code, typeCode: opts.typeCode, signDate: opts.sign ?? null } as any,
    });
    if (opts.bidStart || opts.bidWin) {
      await ctx.prisma.contractExt.create({
        data: { contractId: c.id, bidStartDate: opts.bidStart ?? null, bidWinDate: opts.bidWin ?? null } as any,
      });
    }
    if (opts.entry) {
      await ctx.prisma.dailyReport.create({
        data: { projectId, contractId: c.id, materialName: '合规性用例物资', entryDate: opts.entry } as any,
      });
    }
    return c;
  };

  const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

  it('六种判定都能被筛选命中，且只返回该结果的行', async () => {
    const project = await makeProject(ctx.prisma, 'LC-1');
    const pid = project.id;

    // 执行类：先进场后签合同
    const execLate = await mk(pid, {
      typeCode: 'PURCHASE_EXEC',
      entry: day(2026, 3, 1),
      sign: day(2026, 4, 1),
    });
    // 执行类：有进场、缺签订 → 时间数据不完整
    const execIncomplete = await mk(pid, { typeCode: 'PURCHASE_EXEC', entry: day(2026, 3, 2) });
    // 执行类：没有进场日报 → 不判定（空串，任何筛选都不该命中）
    const execNoEntry = await mk(pid, { typeCode: 'PURCHASE_EXEC', sign: day(2026, 4, 2) });
    // 非执行类：进场早于开始招标
    const beforeBid = await mk(pid, {
      typeCode: 'PURCHASE',
      entry: day(2026, 1, 5),
      bidStart: day(2026, 2, 1),
      bidWin: day(2026, 2, 10),
      sign: day(2026, 3, 1),
    });
    // 非执行类：招标之后、定标之前进场
    const beforeWin = await mk(pid, {
      typeCode: 'PURCHASE',
      entry: day(2026, 2, 5),
      bidStart: day(2026, 2, 1),
      bidWin: day(2026, 2, 10),
      sign: day(2026, 3, 1),
    });
    // 非执行类：定标之后、签订之前进场
    const beforeSign = await mk(pid, {
      typeCode: 'PURCHASE',
      entry: day(2026, 2, 20),
      bidStart: day(2026, 2, 1),
      bidWin: day(2026, 2, 10),
      sign: day(2026, 3, 1),
    });
    // 非执行类：晚于签订进场 → 无问题
    const okRow = await mk(pid, {
      typeCode: 'PURCHASE',
      entry: day(2026, 3, 5),
      bidStart: day(2026, 2, 1),
      bidWin: day(2026, 2, 10),
      sign: day(2026, 3, 1),
    });
    // 非执行类：没有进场日报 → 时间数据不完整
    const noEntry = await mk(pid, { typeCode: 'PURCHASE', sign: day(2026, 3, 1) });

    const idsFor = async (compliance: string) => {
      const res: any = await ledger.findAll({ compliance, pageSize: 200 }, pid);
      return { ids: res.list.map((r: any) => r.id).sort(), total: res.total, rows: res.list };
    };

    const execLateRes = await idsFor(LEDGER_COMPLIANCE.ENTRY_BEFORE_SIGN_EXEC);
    assert.deepEqual(execLateRes.ids, [execLate.id], '执行类先进场后签合同，只该命中这一份');
    assert.equal(execLateRes.total, 1, 'total 必须是命中条数，不是未过滤总数');

    const incomplete = await idsFor(LEDGER_COMPLIANCE.INCOMPLETE);
    assert.deepEqual(incomplete.ids, [execIncomplete.id, noEntry.id].sort(), '两份「时间数据不完整」');

    assert.deepEqual((await idsFor(LEDGER_COMPLIANCE.ENTRY_BEFORE_BID)).ids, [beforeBid.id]);
    assert.deepEqual((await idsFor(LEDGER_COMPLIANCE.ENTRY_BEFORE_WIN)).ids, [beforeWin.id]);
    assert.deepEqual((await idsFor(LEDGER_COMPLIANCE.ENTRY_BEFORE_SIGN)).ids, [beforeSign.id]);
    assert.deepEqual((await idsFor(LEDGER_COMPLIANCE.OK)).ids, [okRow.id]);

    // 不判定的合同（执行类无进场）不该被任何筛选命中
    for (const v of Object.values(LEDGER_COMPLIANCE)) {
      const res = await idsFor(v);
      assert.equal(res.ids.includes(execNoEntry.id), false, '空串（不判定）不该命中「' + v + '」');
    }
  });

  it('分页：total 稳定、跨页不重不漏、行号连续', async () => {
    const project = await makeProject(ctx.prisma, 'LC-2');
    const pid = project.id;
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(
        await mk(pid, {
          typeCode: 'PURCHASE',
          entry: day(2026, 2, 20),
          bidStart: day(2026, 2, 1),
          bidWin: day(2026, 2, 10),
          sign: day(2026, 3, 1),
        }),
      );
    }

    const p1: any = await ledger.findAll({ compliance: LEDGER_COMPLIANCE.ENTRY_BEFORE_SIGN, page: 1, pageSize: 2 }, pid);
    const p2: any = await ledger.findAll({ compliance: LEDGER_COMPLIANCE.ENTRY_BEFORE_SIGN, page: 2, pageSize: 2 }, pid);

    assert.equal(p1.total, 3);
    assert.equal(p2.total, 3, 'total 与页码无关');
    assert.equal(p1.list.length, 2);
    assert.equal(p2.list.length, 1);
    const ids = [...p1.list, ...p2.list].map((r: any) => r.id);
    assert.equal(new Set(ids).size, 3, '两页合起来正好三份、不重复');
    assert.deepEqual([...p1.list, ...p2.list].map((r: any) => r.index), [1, 2, 3], '行号跨页连续');
    // 顺序与未筛选时一致：createdAt desc（最后创建的排最前）
    assert.equal(p1.list[0].id, created[2].id, '第 1 页首行应是最新创建的那份');

    // 未筛选时 total 是全项目合同数（不因筛选分支而变）
    const all: any = await ledger.findAll({ pageSize: 200 }, pid);
    assert.equal(all.total, 3);
  });
});
