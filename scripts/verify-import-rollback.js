/**
 * P0 验收脚本：验证「全成功或全失败」导入事务
 *
 * 场景：
 *  1. 生成 1000 行供应商数据（其中第 500 行供应商名称为空 → 校验失败）
 *  2. 登录获取 token + 项目 ID
 *  3. 调用导入接口
 *  4. 断言：返回 errors.length === 1、created === 0、updated === 0
 *  5. 断言：数据库中供应商总数与导入前一致（无任何数据写入）
 */
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://[::1]:3000/api';
const USER = process.env.USER_NAME || 'admin';
const PASS = process.env.PASSWORD || 'admin123';

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(`登录失败：${json.message}`);
  return json.data.token;
}

async function projects(token) {
  const res = await fetch(`${BASE}/projects?pageNum=1&pageSize=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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

async function buildFile(total, badRow) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  // 第 1 行表头，第 2 行示例行（解析时跳过）
  ws.addRow(['供应商名称', '法人姓名', '联系人姓名', '联系人电话', '银行名称', '银行账号', '公司地址', '状态']);
  ws.addRow(['示例行：导入时自动忽略', '张三', '王五', '13800000003', '建设银行', '31001234', '上海市', '启用']);
  for (let i = 1; i <= total; i++) {
    const name = i === badRow ? '' : `压测供应商-${Date.now()}-${i}`;
    ws.addRow([name, '法人' + i, '联系人' + i, '1380000000' + (i % 10), '建设银行', 'ACCT' + i, '上海市某某路', '启用']);
  }
  const file = path.join(__dirname, 'import-rollback-test.xlsx');
  await wb.xlsx.writeFile(file);
  return file;
}

async function importFile(token, projectId, file) {
  const FormData = globalThis.FormData;
  const { Blob } = require('buffer');
  const buf = fs.readFileSync(file);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'import.xlsx');
  const res = await fetch(`${BASE}/suppliers/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-project-id': projectId },
    body: fd,
  });
  return res.json();
}

(async () => {
  const total = Number(process.env.ROWS || 1000);
  const badRow = Number(process.env.BAD_ROW || 500);
  const token = await login();
  const project = await projects(token);
  if (!project) throw new Error('未找到项目，请先初始化种子数据');
  const before = await countSuppliers(token, project.id);
  const file = await buildFile(total, badRow);
  console.log(`已生成导入文件：${total} 行，其中第 ${badRow} 行为错误数据`);
  console.log(`导入前供应商总数：${before}`);

  const res = await importFile(token, project.id, file);
  console.log('导入响应：', JSON.stringify({ code: res.code, created: res.data?.created, updated: res.data?.updated, errors: res.data?.errors }, null, 2));

  const after = await countSuppliers(token, project.id);
  console.log(`导入后供应商总数：${after}`);

  const errors = res.data?.errors || [];
  const ok =
    res.code === 0 &&
    errors.length === 1 &&
    res.data.created === 0 &&
    res.data.updated === 0 &&
    before === after &&
    /供应商名称为必填项/.test(errors[0]?.message || '');
  console.log('\n================ 验收结论 ================');
  console.log(ok ? '✅ 通过：1000 行含 1 行错误 → 全部回滚，数据库未产生任何变更' : '❌ 未通过：存在脏数据或未正确回滚');
  fs.unlinkSync(file);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('执行失败：', e.message);
  process.exit(1);
});
