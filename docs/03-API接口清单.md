# 03 · API 接口清单

- 基地址：`http://localhost:3000/api`
- 统一返回：`{ code: 0, data: any, message: 'ok' }`，`code !== 0` 为业务异常（如 1001 参数错误、1401 未登录、1403 无权限、1500 服务端异常）。
- 鉴权：`Authorization: Bearer <token>`；项目上下文：`x-project-id: <projectId>`。
- 公共查询参数：`page`(默认1)、`pageSize`(默认20)、`keyword`、各业务筛选字段。

## 1. 认证 /auth

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 登录，返回 token + userInfo + projects |
| POST | `/auth/logout` | 退出（记录日志） |
| GET | `/auth/profile` | 当前用户、权限码、可访问项目、系统参数 |
| POST | `/auth/password` | 修改密码 |

## 2. 字典 /dict

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dict/types` | 字典类型列表（搜索、分页） |
| POST | `/dict/types` | 新增类型 |
| PUT | `/dict/types/:id` | 修改类型 |
| DELETE | `/dict/types/:id` | 删除类型（含字典项的一并校验） |
| GET | `/dict/items` | 字典项列表（`typeCode` 必填，含停用项） |
| GET | `/dict/options/:typeCode` | 下拉选项（仅启用，支持 `extValue` 过滤联动） |
| POST | `/dict/items` | 新增字典项（校验 code 唯一） |
| PUT | `/dict/items/:id` | 修改字典项 |
| DELETE | `/dict/items/:id` | 删除（被业务引用返回「该选项已被使用，不可删除」） |
| POST | `/dict/items/:id/toggle` | 启用/停用 |
| POST | `/dict/items/sort` | 批量排序 |
| GET | `/dict/export?typeCode=` | 导出 Excel |
| POST | `/dict/import` | 导入 Excel |
| POST | `/dict/cache/refresh` | 手动刷新字典缓存 |

## 3. 项目 /projects

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 我参与的项目列表 |
| GET | `/projects/all` | 全部项目（系统管理员） |
| POST | `/projects` | 新建项目 |
| GET | `/projects/:id` | 详情（含成员） |
| PUT | `/projects/:id` | 修改 |
| DELETE | `/projects/:id` | 删除（有业务数据时禁止） |
| GET | `/projects/:id/members` | 成员列表 |
| POST | `/projects/:id/members` | 添加成员（指定项目角色） |
| DELETE | `/projects/:id/members/:userId` | 移除成员 |

## 4. 供应商 /suppliers

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/suppliers` | 列表（分页、关键词、状态） |
| GET | `/suppliers/options` | 下拉（仅启用，按系统参数决定是否项目隔离） |
| GET | `/suppliers/:id` | 详情 |
| POST | `/suppliers` | 新增（名称唯一校验） |
| PUT | `/suppliers/:id` | 修改 |
| DELETE | `/suppliers/:id` | 删除（被合同引用只可停用） |
| POST | `/suppliers/:id/toggle` | 启用/停用 |
| GET | `/suppliers/export` · POST `/suppliers/import` | Excel 导入导出 |

## 5. 合同 /contracts

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/contracts` | 列表（按项目，支持编号/名称/类型/供应商/执行情况/审批状态筛选） |
| GET | `/contracts/options` | 下拉（当前项目） |
| GET | `/contracts/:id` | 详情（含供应商信息、扩展信息、附件） |
| POST | `/contracts` | 新增（编号查重 + 字典校验） |
| PUT | `/contracts/:id` | 修改（记录变更日志） |
| DELETE | `/contracts/:id` | 删除（仅草稿） |
| GET | `/contracts/check-code?code=&excludeId=` | 编号实时查重 |
| POST | `/contracts/:id/submit` | 提交审批 |
| POST | `/contracts/:id/approve` | 审批（action: APPROVED/REJECTED，comment） |
| GET | `/contracts/:id/changes` | 变更记录 |
| PUT | `/contracts/:id/ext` | 保存扩展信息（台账补充字段） |
| POST | `/contracts/import` · GET `/contracts/export` | Excel |

## 6. 合同模板 /templates

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/templates` | 模板列表 |
| GET | `/templates/:id` | 详情（含变量） |
| POST | `/templates` | 新增（生成 v1） |
| PUT | `/templates/:id` | 修改并生成新版本 |
| DELETE | `/templates/:id` | 删除 |
| POST | `/templates/:id/toggle` | 启用/停用 |
| GET | `/templates/:id/versions` | 版本列表 |
| POST | `/templates/:id/rollback` | 回滚到指定版本 |
| GET | `/templates/guide/categories?isFramework=&isSupplement=&contractType=` | 向导步骤三：可用模板分类 |
| POST | `/templates/guide/generate` | 按模板 + 合同 + 供应商生成合同正文（变量替换） |
| GET/POST | `/templates/clauses` | 条款库列表/新增 |
| DELETE | `/templates/clauses/:id` | 删除条款 |

## 7. 日报 /daily-reports

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/daily-reports` | 列表（账期、合同、供应商、材料类别等筛选） |
| GET | `/daily-reports/:id` · POST · PUT · DELETE | CRUD |
| GET | `/daily-reports/export` · POST `/daily-reports/import` | Excel（按台账列顺序） |
| GET | `/daily-reports/material-types?category=` | 物资种类联动（读字典 extField1） |

## 8. 合同清单 /contract-items

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/contract-items` | 列表（合同、供应商、物资类别筛选） |
| POST / PUT / DELETE | `/contract-items[/:id]` | CRUD |
| POST | `/contract-items/generate/:contractId` | 由合同明细生成 |
| GET/POST | `/contract-items/export` · `/contract-items/import` | Excel |

## 9. 结算与付款 /settlements · /payments

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/settlements[/:id]` | 结算单 CRUD（按项目） |
| GET/POST/PUT/DELETE | `/settlements/ledger[/:id]` | 结算台账 CRUD |
| GET | `/payments/plans` 及 CRUD | 付款计划 |
| GET | `/payments/applies` 及 CRUD | 付款申请（自动带出收款方/银行） |
| POST | `/payments/applies/:id/approve` | 付款审批 |
| GET | `/payments/records` 及 CRUD | 付款执行 / 付款台账 |
| POST | `/payments/verifications` | 付款-发票核销 |
| GET | `/payments/overdue` | 逾期提醒（应付未付） |

## 10. 发票 /invoices

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/invoices[/:id]` | 收票登记 / 发票台账 |
| GET | `/invoices/check-no?no=` | 发票号码查重（项目内） |
| POST | `/invoices/:id/verify` | 查验（预留第三方接口） |
| GET/POST | `/invoices/applies` | 开票申请列表/新增 |
| POST | `/invoices/applies/:id/approve` | 开票审批 |
| GET/POST | `/invoices/export` · `/invoices/import` | Excel |

## 11. 合同台账 /ledger

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ledger/contracts` | 台账数据（36 列，按项目，批量聚合 + 合规性问题计算） |
| GET | `/ledger/columns` | 列配置（默认显隐） |
| PUT | `/ledger/columns` | 保存列显隐配置 |
| GET | `/ledger/export` | 导出 Excel（按当前列配置） |
| GET | `/ledger/summary` | 台账汇总指标（合同总额、结算、付款、发票） |

## 12. 还款协议 /repayments

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/repayments` | 列表（协议编号、供应商、签订日期筛选） |
| GET | `/repayments/:id` | 详情（含明细） |
| POST | `/repayments` | 新增（主表 + 至少一条明细，编号项目内唯一） |
| PUT | `/repayments/:id` | 修改（明细整体覆盖） |
| DELETE | `/repayments/:id` | 删除 |
| GET | `/repayments/export` | 导出 Excel |

## 13. 审批 /approvals

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/approvals/todo` · `/approvals/done` · `/approvals/mine` | 待审批/已审批/我发起的 |
| POST | `/approvals/:id/approve` | 审批动作（通过/驳回/转办） |
| GET/POST/PUT/DELETE | `/approvals/flows[/:id]` | 流程定义 CRUD |

## 14. 通知 /notifications

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/notifications` | 列表（未读优先） |
| POST | `/notifications/:id/read` · `/notifications/read-all` | 标记已读 |
| GET | `/notifications/unread-count` | 未读数 |

## 15. 看板 /dashboard

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dashboard/overview` | 关键指标卡（合同数/合同额/结算额/付款额/发票额/待办） |
| GET | `/dashboard/trend` | 收付款与结算趋势（按月） |
| GET | `/dashboard/contract-type` | 合同类型分布 |
| GET | `/dashboard/invoice-stats` | 发票统计（按类型/状态） |
| GET | `/dashboard/reminders` | 到期/逾期/付款计划提醒 |

## 16. 系统管理 /system

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/system/users[/:id]` | 用户管理（含角色分配） |
| POST | `/system/users/:id/reset-password` | 重置密码 |
| GET/POST/PUT/DELETE | `/system/roles[/:id]` | 角色管理（含权限分配） |
| GET | `/system/permissions` | 权限树（按模块） |
| GET/POST/PUT/DELETE | `/system/depts[/:id]` | 部门管理 |
| GET/PUT | `/system/params` | 系统参数（编号唯一性策略、供应商共享范围等） |
| GET | `/system/logs/operations` · `/system/logs/logins` | 操作日志 / 登录日志 |

## 17. 文件 /files

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/files/upload` | 单/多文件上传（本地存储，返回 url） |
| GET | `/files/*` | 静态文件访问 |
