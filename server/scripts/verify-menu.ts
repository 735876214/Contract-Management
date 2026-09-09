/** 联调验证：三个账号登录 → GET /api/menu → 校验权限过滤结果 */
const BASE = 'http://localhost:3000/api';

async function login(username: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'admin123' }),
  });
  const json: any = await res.json();
  const token = json?.data?.token ?? json?.data?.accessToken;
  if (!token) throw new Error(`${username} 登录失败: ${JSON.stringify(json)}`);
  return token;
}

async function getMenu(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/menu`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json: any = await res.json();
  if (json.code !== 0 && json.code !== 200) throw new Error(`menu 接口异常: ${JSON.stringify(json)}`);
  return json.data ?? json;
}

function walk(nodes: any[], path = ''): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const p = `${path}/${n.label}`;
    if (!n.children || n.children.length === 0) out.push(p);
    else out.push(...walk(n.children, p));
  }
  return out;
}

async function main() {
  for (const user of ['admin', 'manager', 'staff']) {
    const token = await login(user);
    const menu = await getMenu(token);
    const leaves = walk(menu);
    console.log(`\n===== ${user} =====`);
    console.log(`顶层菜单组 (${menu.length}): ${menu.map((m: any) => m.label).join(' | ')}`);
    console.log(`可见叶子菜单 (${leaves.length}):`);
    for (const l of leaves) console.log(`  ${l}`);
  }
  console.log('\n联调验证完成');
}

main().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
