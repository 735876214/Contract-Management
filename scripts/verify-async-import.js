/**
 * P2 异步导入验收（需求 2.7）：
 *  场景 A：1200 行全部有效 → 返回 taskId（异步），轮询至 SUCCESS，成功 1200 行，站内通知 +1
 *  场景 B：1200 行含 1 行错误 → 任务 FAILED，failCount=1，全部回滚，可下载错误报告
 */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://[::1]:3000/api';
const ROWS = Number(process.env.ROWS || 1200);

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`登录失败：${json.message}`);
  return json.data.token;
}

async function firstProject(token) {
  const res = await fetch(`${BASE}/projects?pageNum=1&pageSize=1`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  return json.data?.list?.[0];
}

async function countSuppliers(token, projectId) {
  const res = await fetch(`${BASE}/suppliers?pageNum=1&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}`, 'x-project-id': projectId },
  });
  const json = await res.json();
  return json.data?.total ?? 0;
}

async function notifications(token) {
  const res = await fetch(`${BASE}/notifications?pageNum=1&pageSize=1`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json();
  return json.data?.total ?? 0;
}

async function buildFile(total, badRow, tag) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.addRow(['供应商名称', '法人姓名', '联系人姓名', '联系人电话', '银行名称', '银行账号', '公司地址', '状态']);
  ws.addRow(['示例行：导入时自动忽略', '张三', '王五', '13800000003', '建设银行', '31001234', '上海市', '启用']);
  for (let i = 1; i <= total; i++) {
    const name = i === badRow ? '' : `异步导入-${tag}-${i}`;
    ws.addRow([name, '法人' + i, '联系人' + i, '1380000000' + (i % 10), '建设银行', 'ACCT' + tag + i, '上海市某某路', '启用']);
  }
  const file = path.join(__dirname, `import-async-${tag}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

async function importFile(token, projectId, file) {
  const FormData = globalThis.FormData;
  const { Blob } = require('buffer');
  const buf = fs.readFileSync(file);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'async-import.xlsx');
  const res = await fetch(`${BASE}/suppliers/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-project-id': projectId },
    body: fd,
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollTask(token, taskId) {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${BASE}/import-tasks/${taskId}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    if (json.data?.status === 'SUCCESS' || json.data?.status === 'FAILED') return json.data;
    await sleep(1000);
  }
  throw new Error('轮询超时');
}

async function cleanup(token, projectId, tag) {
  // 按名称清理本脚本的测试数据，保证可重复执行
  for (let i = 1; i <= ROWS; i++) {
    const name = `异步导入-${tag}-${i}`;
    const res = await fetch(`${BASE}/suppliers?keyword=${encodeURIComponent(name)}&pageSize=1`, {
      headers: { Authorization: `Bearer ${token}`, 'x-project-id': projectId },
    });
    const json = await res.json();
    const hit = json.data?.list?.[0];
    if (hit) await fetch(`${BASE}/suppliers/${hit.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'x-project-id': projectId } });
  }
}

async function runCase(tag, badRow) {
  const token = await login();
  const project = await firstProject(token);
  const before = await countSuppliers(token, project.id);
  const notifBefore = await notifications(token);
  const file = await buildFile(ROWS, badRow, tag);
  const res = await importFile(token, project.id, file);
  console.log(`\n[场景 ${tag}] 提交响应：`, JSON.stringify({ code: res.code, async: res.data?.async, taskId: res.data?.taskId, errors: res.data?.errors }));
  if (!res.data?.taskId) throw new Error('预期返回异步任务 ID，实际未返回');
  const task = await pollTask(token, res.data.taskId);
  console.log(`[场景 ${tag}] 任务结果：`, JSON.stringify(task));
  const after = await countSuppliers(token, project.id);
  const notifAfter = await notifications(token);
  console.log(`[场景 ${tag}] 供应商数：${before} -> ${after}；通知数：${notifBefore} -> ${notifAfter}`);
  fs.unlinkSync(file);
  return { token, project, task, before, after, notifBefore, notifAfter, taskId: res.data.taskId };
}

(async () => {
  const ok = await runCase('ok', 0);
  const bad = await runCase('bad', 600);

  const A =
    ok.task.status === 'SUCCESS' &&
    ok.task.successCount === ROWS &&
    ok.after - ok.before === ROWS &&
    ok.notifAfter > ok.notifBefore;
  const B =
    bad.task.status === 'FAILED' &&
    bad.task.failCount === 1 &&
    bad.task.successCount === 0 &&
    bad.after === bad.before &&
    !!bad.task.errorFileUrl;

  console.log('\n================ 验收结论 ================');
  console.log(`场景 A（1200 行全部有效 → 异步执行 + 通知）：${A ? '✅ 通过' : '❌ 未通过'}`);
  console.log(`场景 B（1200 行含 1 错 → 任务失败 + 全量回滚 + 错误报告）：${B ? '✅ 通过' : '❌ 未通过'}`);
  if (A) await cleanup(ok.token, ok.project.id, 'ok');
  process.exit(A && B ? 0 : 1);
})().catch((e) => {
  console.error('执行失败：', e.message);
  process.exit(1);
});
