/**
 * 采购工作流端到端模拟（临时脚本，跑完即删）
 * 覆盖：三种采购类型全阶段链 + 门禁 + 多合同 + 三处驳回 + 下游（收领单/结算）
 * 运行：node e2e-flow.tmp.mjs   （走 5173 前端代理，模拟真实用户路径）
 */
const BASE = 'http://localhost:5173/api';
const results = [];
const ok = (name, cond, extra = '') => results.push([cond ? 'PASS' : 'FAIL', name, extra]);
const today = () => new Date().toISOString().slice(0, 10);

let token, pid, UNIT;
const unit = () => UNIT;
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-project-id': pid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, code: json?.code, data: json?.data, message: json?.message ?? json?.msg };
}
async function must(name, method, path, body) {
  const r = await api(method, path, body);
  const pass = r.status < 300 && r.code === 0;
  ok(name, pass, pass ? '' : `HTTP ${r.status} code=${r.code} ${String(r.message).slice(0, 160)}`);
  if (!pass) { console.error(`  !! ${name} 失败详情:`, JSON.stringify(r).slice(0, 400)); throw new Error(`ABORT: ${name}`); }
  return r.data;
}
async function mustFail(name, method, path, body) {
  const r = await api(method, path, body);
  ok(name, r.code !== 0, `实际 code=${r.code} ${String(r.message).slice(0, 120)}`);
  return r;
}
const stagesOf = (d) => (d.stages || []).map((s) => `${s.key}:${s.state}`).join(', ');
const contractsOfTask = async (taskId) => {
  const r = await api('GET', `/contracts?page=1&pageSize=100`);
  return (r.data?.list || []).filter((c) => c.taskId === taskId);
};

// ---------- 流程 1：紧急采购（总清单 → 合同，单合同） ----------
async function flowEmergency() {
  console.log('\n===== 流程 1：紧急采购 EMERGENCY =====');
  const t = await must('创建紧急采购任务', 'POST', '/procurement-tasks', { type: 'EMERGENCY', content: 'E2E-紧急采购', procurementCategory: '物资' });
  let d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('紧急采购阶段链 = 总清单(编辑中)+合同(锁定)', stagesOf(d) === 'TOTAL_LIST:editing, CONTRACT:locked', stagesOf(d));

  await mustFail('门禁：总清单未编制不得发布', 'POST', `/procurement-tasks/${t.id}/publish`);
  const list = (await api('GET', '/materials?page=1&pageSize=1')).data?.list || [];
  ok('物资基础库有数据（seed）', list.length > 0);
  await must('编制总采购清单', 'PUT', `/procurement-tasks/${t.id}/total-list`, {
    items: [{ materialBaseId: list[0].id, unit: UNIT, qty: 10, incomePrice: 1000, stdCost: 800, marketPrice: 1200, infoPrice: 1100 }],
  });
  await must('发布总采购清单 → 进入合同阶段', 'POST', `/procurement-tasks/${t.id}/publish`);
  d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('全部子阶段 done 且合同阶段 editing', stagesOf(d) === 'TOTAL_LIST:done, CONTRACT:editing', stagesOf(d));
  ok('自动生成合同（task.contractId）', !!d.contractId, d.contractId || 'null');
  const c = (await contractsOfTask(t.id))[0] || {};
  ok('紧急采购只生成 1 份合同', (await contractsOfTask(t.id)).length === 1);
  ok('合同类型推导 = EMERGENCY（紧急采购合同）', c.contractType === 'EMERGENCY', c.contractType);
  ok('合同 taskId 关联', c.taskId === t.id);
  return { taskId: t.id, contractId: d.contractId };
}

// ---------- 流程 2：单项采购租赁（公告→文件→成交报告→价格对比表，多合同 + 两处驳回） ----------
async function flowSingle() {
  console.log('\n===== 流程 2：单项采购 SINGLE（租赁，<100 万）=====');
  const t = await must('创建单项采购任务', 'POST', '/procurement-tasks', { type: 'SINGLE', content: 'E2E-单项采购租赁', procurementCategory: '租赁' });
  const list = (await api('GET', '/materials?page=1&pageSize=1')).data?.list || [];
  await must('编制总采购清单（金额 <100 万）', 'PUT', `/procurement-tasks/${t.id}/total-list`, {
    items: [{ materialBaseId: list[0].id, unit: UNIT, qty: 8, incomePrice: 950, stdCost: 700, marketPrice: 1100, infoPrice: 1000 }],
  });
  await must('发布总清单', 'POST', `/procurement-tasks/${t.id}/publish`);
  let d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  const chain = stagesOf(d);
  ok('<100 万无采前会，公告为当前阶段且文件/成交报告/价格对比表仍锁定', !chain.includes('PRE_MEETING') && chain.includes('NOTICE:editing') && ['DOCUMENT', 'RESULT_REPORT', 'PRICE_COMPARE'].every((k) => chain.includes(`${k}:locked`)), chain);
  ok('公告为当前编辑阶段', chain.includes('NOTICE:editing'), chain);

  await mustFail('门禁：未保存采购公告不得发布', 'POST', `/procurement-tasks/${t.id}/publish`);
  await must('保存采购公告', 'PUT', `/procurement-tasks/${t.id}/notice`, { procurementNo: 'E2E-GG-001', procurementTime: `${today()}T09:00:00.000Z`, content: 'E2E 采购公告内容' });
  await must('发布采购公告', 'POST', `/procurement-tasks/${t.id}/publish`);
  await must('保存采购文件', 'PUT', `/procurement-tasks/${t.id}/document`, { procurementTime: `${today()}T10:00:00.000Z`, responseDeposit: 10000 });
  await must('发布采购文件', 'POST', `/procurement-tasks/${t.id}/publish`);
  d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('成交报告进入编辑中', stagesOf(d).includes('RESULT_REPORT:editing'), stagesOf(d));

  await mustFail('门禁：成交报告未填开启时间不得发布', 'POST', `/procurement-tasks/${t.id}/publish`);
  await must('保存成交报告（勾选两家成交单位）', 'PUT', `/procurement-tasks/${t.id}/result-report`, {
    openTime: `${today()}T14:00:00.000Z`, unitCount: 2, approvedCount: 2,
    suppliers: [{ name: '滨江建设集团' }, { name: '中建三局' }],
    candidates: [{ name: '滨江建设集团', finalPreTaxPrice: 80000 }, { name: '中建三局', finalPreTaxPrice: 65000 }],
  });
  await must('发布成交报告', 'POST', `/procurement-tasks/${t.id}/publish`);
  await must('保存采购价格对比表', 'PUT', `/procurement-tasks/${t.id}/price-compare`, { pricingMethod: 'FIXED', benefitAnalysis: '<p>E2E 采购效益分析</p>', items: [] });
  await must('发布价格对比表 → 全部阶段完成', 'POST', `/procurement-tasks/${t.id}/publish`);
  d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('合同阶段 editing', stagesOf(d).includes('CONTRACT:editing'), stagesOf(d));

  let cs = await contractsOfTask(t.id);
  ok('多合同：两家成交单位 → 2 份合同', cs.length === 2, `实际 ${cs.length} 份`);
  ok('合同类型推导 = LEASE（单项+租赁）', cs.every((c) => c.contractType === 'LEASE'), cs.map((c) => c.contractType).join(','));
  ok('合同金额随单位带入', cs.some((c) => Number(c.amount) === 80000) && cs.some((c) => Number(c.amount) === 65000), cs.map((c) => c.amount).join(','));

  // 驳回①：成交报告退回 → 重发
  console.log('  ---- 驳回① 成交报告退回 → 重发 ----');
  await must('退回成交报告（合同均为草稿，允许退回）', 'POST', `/procurement-tasks/${t.id}/reject-result-report`);
  d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('阶段回退到成交报告编制中，价格对比表重新锁定', stagesOf(d).includes('RESULT_REPORT:editing') && stagesOf(d).includes('PRICE_COMPARE:locked'), stagesOf(d));
  ok('已自动生成的草稿合同被清理', (await contractsOfTask(t.id)).length === 0);
  await must('重发：重新发布成交报告', 'POST', `/procurement-tasks/${t.id}/publish`);
  await must('重发：重新发布价格对比表 → 合同重新生成', 'POST', `/procurement-tasks/${t.id}/publish`);
  cs = await contractsOfTask(t.id);
  ok('重发后重新生成 2 份合同', cs.length === 2, `实际 ${cs.length} 份`);

  // 驳回②：合同签章驳回 → 合同起草
  console.log('  ---- 驳回② 合同签章驳回 → 合同起草 ----');
  const main = cs.find((c) => c.id === d.contractId) || cs[0];
  const sub = cs.find((c) => c.id !== main.id);
  await must('主合同推送审批（APPROVING）', 'PUT', `/contracts/${main.id}/status`, { status: 'APPROVING' });
  await must('副合同也推送审批（APPROVING）', 'PUT', `/contracts/${sub.id}/status`, { status: 'APPROVING' });
  const rejected = await must('签章驳回 → 回合同起草（DRAFT）', 'POST', `/contracts/${main.id}/reject`);
  ok('主合同状态回 DRAFT', rejected.status === 'DRAFT', rejected.status);
  d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('任务状态同步回「合同编制中」', d.status === 'CONTRACT_EDITING', d.status);
  ok('副合同不受影响（多合同下游各自独立，仍为审批中）', (await contractsOfTask(t.id)).find((c) => c.id === sub.id)?.status === 'APPROVING');
  await mustFail('门禁：草稿合同不可重复驳回', 'POST', `/contracts/${main.id}/reject`);
  return { taskId: t.id, contracts: cs };
}

// ---------- 流程 3：引用框架协议（价格对比表 → 自动灌入框架说明 → 单位必填 → 多合同） ----------
async function flowFramework() {
  console.log('\n===== 流程 3：引用框架协议 FRAMEWORK =====');
  const t = await must('创建框架协议任务', 'POST', '/procurement-tasks', { type: 'FRAMEWORK', content: 'E2E-引用框架协议', procurementCategory: '物资' });
  const list = (await api('GET', '/materials?page=1&pageSize=1')).data?.list || [];
  await must('编制总采购清单', 'PUT', `/procurement-tasks/${t.id}/total-list`, {
    items: [{ materialBaseId: list[0].id, unit: UNIT, qty: 6, incomePrice: 900, stdCost: 700, marketPrice: 1000, infoPrice: 950 }],
  });
  await must('发布总清单', 'POST', `/procurement-tasks/${t.id}/publish`);
  let d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('框架链 = 总清单→价格对比表→框架说明（价格对比表在前）', stagesOf(d) === 'TOTAL_LIST:done, PRICE_COMPARE:editing, FRAMEWORK_EXPLAIN:locked, CONTRACT:locked', stagesOf(d));

  const pc = await must('查看价格对比表明细行（总清单派生）', 'GET', `/procurement-tasks/${t.id}/price-compare`);
  await must('保存价格对比表（录入成交价）', 'PUT', `/procurement-tasks/${t.id}/price-compare`, {
    pricingMethod: 'FLOATING', benefitAnalysis: '<p>E2E 框架效益分析</p>',
    items: (pc.items || []).map((it) => ({ ...it, dealPrice: 880, remark: 'E2E' })),
  });
  await must('发布价格对比表', 'POST', `/procurement-tasks/${t.id}/publish`);
  const fe = await must('查看框架协议事前说明', 'GET', `/procurement-tasks/${t.id}/framework-explanation`);
  ok('价格对比表明细已自动灌入事前说明', (fe?.data?.priceCompareRows || []).length > 0, JSON.stringify(fe?.data?.priceCompareRows || []).slice(0, 100));

  await must('保存框架简介（不勾选单位）', 'PUT', `/procurement-tasks/${t.id}/framework-explanation`, { frameworkIntro: 'E2E 框架简介' });
  await mustFail('门禁：未勾选单位不得发起框架说明', 'POST', `/procurement-tasks/${t.id}/publish`);
  await must('勾选两家引用供应商及金额', 'PUT', `/procurement-tasks/${t.id}/framework-explanation`, {
    frameworkIntro: 'E2E 框架简介',
    referenceSuppliers: [{ supplier: '滨江建设集团', amount: 30000 }, { supplier: '中建三局', amount: 20000 }],
  });
  await must('发布框架说明 → 全部阶段完成', 'POST', `/procurement-tasks/${t.id}/publish`);
  d = await must('查看任务详情', 'GET', `/procurement-tasks/${t.id}`);
  ok('合同阶段 editing', stagesOf(d).includes('CONTRACT:editing'), stagesOf(d));
  const cs = await contractsOfTask(t.id);
  ok('多合同：两家引用单位 → 2 份合同', cs.length === 2, `实际 ${cs.length} 份`);
  ok('合同类型推导 = PURCHASE_EXEC（框架+物资）', cs.every((c) => c.contractType === 'PURCHASE_EXEC'), cs.map((c) => c.contractType).join(','));
  ok('isFramework 标记', cs.every((c) => c.isFramework === 'Y'));
  return { taskId: t.id };
}

// ---------- 流程 4：下游（收领单 → 日报；结算 → 驳回回填） ----------
async function flowDownstream(emergency) {
  console.log('\n===== 流程 4：下游（收领单 → 日报；结算 → 驳回）=====');
  const suppliers = (await api('GET', '/suppliers?page=1&pageSize=5')).data?.list || [];
  ok('供应商库有数据（seed）', suppliers.length > 0);
  const order = await must('登记收领单（供应单位=供应商 → 必选物资合同）', 'POST', '/receipt-orders', {
    supplierId: suppliers[0].id, supplierName: suppliers[0].name, supplierType: 'SUPPLIER',
    receivingUnitId: suppliers[0].id, receivingUnitName: suppliers[0].name, receivingUnitType: 'SELF_PROJECT',
    materialContractId: emergency.contractId,
    orderDate: today(), remark: 'E2E', details: [],
  });
  ok('收领单创建成功且自动标记已推送日报', !!order.orderNo && !!order.pushedAt, `orderNo=${order.orderNo}`);
  const dr = await api('GET', `/daily-reports?page=1&pageSize=5`);
  ok('日报模块可查询（收领单无明细，日报为空属预期）', dr.code === 0, `total=${dr.data?.total}`);

  const s = await must('办理结算（已确认）', 'POST', '/settlements', {
    contractId: emergency.contractId, code: `JS-E2E-${Date.now() % 100000}`, typeCode: 'PROGRESS',
    amount: 10000, deductAmount: 0, actualAmount: 10000, settleDate: today(), statusCode: 'CONFIRMED', remark: 'E2E',
  });
  const rejected = await must('结算驳回 → 回填（回草稿）', 'POST', `/settlements/${s.id}/reject`);
  ok('结算状态回 DRAFT，可重新编辑提交', rejected.statusCode === 'DRAFT', rejected.statusCode);
  await mustFail('门禁：草稿结算不可重复驳回', 'POST', `/settlements/${s.id}/reject`);
}

// ---------- 主流程 ----------
(async () => {
  try {
    const login = await api('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    if (login.code !== 0) throw new Error('登录失败: ' + JSON.stringify(login).slice(0, 200));
    token = login.data.token;
    pid = (login.data.projects.find((p) => p.name.includes('滨江')) || login.data.projects[0]).id;
    ok('登录（经 5173 前端代理）', true, `项目=${pid}`);
    const opts = await api('GET', '/dict/options/measurement_unit');
    UNIT = (opts.data || [])[0]?.label;
    if (!UNIT) throw new Error('字典缺少计量单位（measurement_unit）');
    ok('获取计量单位字典', true, UNIT);

    const em = await flowEmergency();
    await flowSingle();
    await flowFramework();
    await flowDownstream(em);
  } catch (e) {
    console.error('\n!! 中断：', e.message);
  }
  const pass = results.filter((r) => r[0] === 'PASS').length;
  console.log(`\n========== 结果：${pass}/${results.length} 通过 ==========`);
  for (const row of results.filter((r) => r[0] === 'FAIL' || r[2])) {
    console.log(`${row[0]}  ${row[1]}${row[2] ? '  | ' + row[2] : ''}`);
  }
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
})();
