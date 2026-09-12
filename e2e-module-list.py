# -*- coding: utf-8 -*-
"""e2e：六模块标准列表（module 参数联表 + 模块状态/特有筛选）"""
import time

import requests

BASE = "http://localhost:3000/api"
PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" | {detail}" if detail and not cond else ""))


def unwrap(r):
    j = r.json()
    return j.get("data") if isinstance(j, dict) and "data" in j else j


for _ in range(30):
    try:
        requests.get(f"{BASE}/menu", timeout=1)
        break
    except Exception:
        time.sleep(1)

r = requests.post(f"{BASE}/auth/login", json={"username": "admin", "password": "admin123"})
token = (unwrap(r) or {}).get("token") or (unwrap(r) or {}).get("accessToken")
check("登录", bool(token))
H = {"Authorization": f"Bearer {token}"}

r = requests.get(f"{BASE}/projects", headers=H, params={"pageSize": 1})
pid = (unwrap(r).get("list") or [{}])[0].get("id")
H2 = {**H, "x-project-id": pid}
check("项目就绪", bool(pid))

# 1. 造数：单项采购 + 总清单 120 万 → 采前会自动判定
r = requests.get(f"{BASE}/materials/options", headers=H2)
mats = unwrap(r) or []
mats = mats if isinstance(mats, list) else mats.get("list", [])
m0 = mats[0]
item = {
    "materialBaseId": m0["id"], "materialName": m0["name"], "spec": m0["spec"], "unit": m0.get("unit") or "个",
    "qty": 300, "incomePrice": 5000, "stdCost": 4000, "marketPrice": 4200, "infoPrice": 4300, "planPrice": 4000,
    "sortOrder": 0,
}
r = requests.post(f"{BASE}/procurement-tasks", headers=H2, json={"type": "SINGLE", "content": "e2e模块列表-测试采购"})
tid = unwrap(r)["id"]
r = requests.put(f"{BASE}/procurement-tasks/{tid}/total-list", headers=H2, json={"items": [item]})
res = unwrap(r)
check("总清单保存且采前会判定", r.status_code in (200, 201) and res.get("preMeetingRequired") is True, r.text[:150])

# 1.5 发布总清单（进入采前会阶段后才能编辑纪要）
r = requests.post(f"{BASE}/procurement-tasks/{tid}/publish", headers=H2)
check("发布总清单", r.status_code in (200, 201), r.text[:150])

# 2. PRE_MEETING 列表：任务出现在列表中，module 为 null（未填写）
r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "type": "SINGLE", "preMeetingRequired": "true", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
row = next((x for x in rows if x["id"] == tid), None)
check("PRE_MEETING 列表含新任务", row is not None)
check("未填写时 module=null", row is not None and row.get("module") is None)

# 3. 保存采前会纪要 → 列表 module 联表字段 + EDITING 状态
r = requests.put(f"{BASE}/procurement-tasks/{tid}/pre-meeting-minutes", headers=H2, json={
    "meetingTime": "2026-09-12", "content": "e2e模块列表-测试采购", "host": "张三",
    "attendees": "李四", "writer": "王五", "reviewer": "赵六",
    "purchaseItems": [], "costRows": [], "techQuality": "", "acceptance": "", "paymentTerms": "",
    "inquirySheets": []})
check("保存采前会纪要", r.status_code in (200, 201), r.text[:150])

r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
row = next((x for x in rows if x["id"] == tid), None)
check("联表返回 host/writer", row is not None and row.get("module", {}).get("host") == "张三"
      and row.get("module", {}).get("writer") == "王五", str(row and row.get("module"))[:150])

r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "moduleStatus": "EDITING", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
check("moduleStatus=EDITING 命中", any(x["id"] == tid for x in rows))
r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "moduleStatus": "PUBLISHED", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
check("moduleStatus=PUBLISHED 不含未发布任务", not any(x["id"] == tid for x in rows))
r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "host": "张三", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
check("host 筛选命中", any(x["id"] == tid for x in rows))
r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "host": "不存在的主持人", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
check("host 筛选不命中", not any(x["id"] == tid for x in rows))
r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "PRE_MEETING", "meetingFrom": "2026-09-01T00:00:00.000Z",
    "meetingTo": "2026-09-30T23:59:59.000Z", "page": 1, "pageSize": 50})
rows = unwrap(r).get("list") or []
check("会议时间区间命中", any(x["id"] == tid for x in rows))

# 4. NOTICE 列表冒烟（联表不报错）
r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={
    "module": "NOTICE", "type": "SINGLE", "page": 1, "pageSize": 10})
check("NOTICE 列表可用", r.status_code == 200, r.text[:120])

# 5. PRICE_COMPARE / FRAMEWORK_EXPLANATION / DOCUMENT / RESULT_REPORT 冒烟
for mk, extra in [("PRICE_COMPARE", {"pricingMethod": "FIXED"}),
                  ("FRAMEWORK_EXPLANATION", {"type": "FRAMEWORK"}),
                  ("DOCUMENT", {"procTimeFrom": "2026-01-01T00:00:00.000Z"}),
                  ("RESULT_REPORT", {"openFrom": "2026-01-01T00:00:00.000Z"})]:
    r = requests.get(f"{BASE}/procurement-tasks", headers=H2, params={"module": mk, "page": 1, "pageSize": 5, **extra})
    check(f"{mk} 列表可用", r.status_code == 200, r.text[:120])

# 清理
requests.delete(f"{BASE}/procurement-tasks/{tid}", headers=H2)

print(f"\n== 结果: {len(PASS)} 通过, {len(FAIL)} 失败 ==")
if FAIL:
    print("失败项:", FAIL)
    raise SystemExit(1)
