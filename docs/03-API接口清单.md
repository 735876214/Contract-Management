# 03 · API 接口清单

> **文档状态**：2026-10-13 按当前代码（`server/src/modules/**/*.controller.ts`）重出，已与实现校准。
> 基准 main @ `0755e7c` + P1 一致性修复。**路由以 controller 为准**，本文与之一一对应（22 个模块）。

## 0. 通用约定

| 项 | 约定 |
|---|---|
| 基地址 | `/api`（Nginx 反代到后端 `PORT`，开发态 vite 亦反代 `/api`） |
| 统一返回 | `{ code, data, message, timestamp }`；`code === 0` 为成功 |
| 错误码 | `1001` 参数错误 · `1401` 未登录 · `1403` 无权限 · `1404` 不存在 · `1409` 乐观锁冲突 · `1500` 服务端异常 |
| 鉴权 | `Authorization: Bearer <token>`（`JwtAuthGuard`） |
| 项目上下文 | `x-project-id: <projectId>`，控制器用 `@ProjectId()` 取值 |
| 权限 | `@RequirePermissions('module:action')` + `PermissionsGuard`；下表「权限」列为**任一即可**（`superAdmin` 直通） |
| 公共查询参数 | `page`（默认 1）、`pageSize`（默认 20）、`keyword`，以及各模块的筛选字段 |
| 乐观锁 | 业务表多有 `version Int`，`PUT` 请求体须带上 `version`，不一致返回 `1409` |

### 项目隔离口径（`CLAUDE.md` 铁律 3）

隔离靠**约定**而非中间件：service 在 `where` 中显式带 `projectId`。**例外**：

| 模块 | 口径 |
|---|---|
| `/dict` | **全局**，无 `projectId`（字典类型/项为全系统共享） |
| `/finance` | 按 `contractId` 归属（合同本身已在项目内），查询**不带** `projectId` 过滤 |
| `/suppliers` | 受系统参数 `supplier.share.scope` 控制：`GLOBAL` 全局共享 / `PROJECT` 按项目隔离 |
| `/contract-templates`（`/templates`）、`/subcontractors` | `projectId = null` 表示**全局共享**，否则按项目 |

> 新增业务表/查询必须自己带上 `projectId` 过滤，否则会跨项目泄漏数据。

### 相对上一版的变更（已移除的接口）

以下端点**已不存在**，旧版本文档中的条目据此删除：`/system/depts`（部门管理已移除）、
`/payments/plans`、`/payments/applies`、`/payments/verifications`（付款计划/申请/核销已重构为单表
`/payments/records`）、`/invoices/applies`（开票申请）。

> **核销（三单匹配）当前不做**：发票与付款之间没有核销关联模型，`/payments/records` 与 `/invoices`
> 各自独立登记，仅通过 `contractId` 间接相关（业务 2026-10-16 再次确认「付款不需要核销」，
> 见 [CLAUDE.md](../CLAUDE.md) §1「已定的产品口径」）。

---

## 1. 认证 `/auth`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/auth/login` | 登录，返回 token + userInfo + 可访问项目 | — |
| GET | `/auth/profile` | 当前用户、权限码、可访问项目、系统参数 | — |
| POST | `/auth/logout` | 退出（记录日志） | — |
| POST | `/auth/password` | 修改密码 | — |

## 2. 菜单 `/menu`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/menu` | 当前用户可见的菜单树（按权限过滤；**菜单权威来源**，与前端 `Sider/menuConfig.ts` 兜底配置对应） | — |

## 3. 字典 `/dict`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/dict/types` | 字典类型列表（搜索、分页） | `dict:view` `system:config` |
| POST | `/dict/types` | 新增类型 | `dict:edit` `system:config` |
| PUT | `/dict/types/:id` | 修改类型 | `dict:edit` `system:config` |
| DELETE | `/dict/types/:id` | 删除类型（含字典项时一并校验） | `dict:edit` `system:config` |
| GET | `/dict/items` | 字典项列表（`typeCode` 必填，含停用项） | `dict:view` `system:config` |
| GET | `/dict/options/:typeCode` | 下拉选项（仅启用，支持 `extValue` 联动过滤） | `dict:view` `system:config` |
| GET | `/dict/options` | 批量下拉选项（多 `typeCode`） | — |
| POST | `/dict/items` | 新增字典项（校验 code 唯一） | `dict:edit` `system:config` |
| PUT | `/dict/items/:id` | 修改字典项 | `dict:edit` `system:config` |
| DELETE | `/dict/items/:id` | 删除（被业务引用返回「该选项已被使用，不可删除」） | `dict:edit` `system:config` |
| POST | `/dict/items/:id/toggle` | 启用/停用 | `dict:edit` `system:config` |
| POST | `/dict/items/sort` | 批量排序 | `dict:edit` `system:config` |
| GET | `/dict/items/usage/:id` | 引用情况（删除前检查） | `dict:edit` `system:config` |
| GET | `/dict/export?typeCode=` | 导出 Excel | `dict:view` `system:config` |
| POST | `/dict/import` | 导入 Excel | `dict:edit` `system:config` |
| POST | `/dict/cache/refresh` | 手动刷新字典缓存 | `dict:edit` `system:config` |

> 项目隔离：**全局**（无 `projectId`）。

## 4. 项目 `/projects`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/projects` | 我参与的项目列表 | `project:view` |
| GET | `/projects/template` | 导入模板下载 | `project:view` |
| GET | `/projects/:id` | 详情（含成员） | `project:view` |
| POST | `/projects` | 新建项目 | `project:edit` |
| POST | `/projects/import` | 导入 Excel | `project:edit` |
| PUT | `/projects/:id` | 修改 | `project:edit` |
| DELETE | `/projects/:id` | 删除（有业务数据时禁止） | `project:edit` |
| GET | `/projects/:id/members` | 成员列表 | `project:view` |
| POST | `/projects/:id/members` | 添加成员（指定项目角色） | `project:edit` |
| DELETE | `/projects/:id/members/:userId` | 移除成员 | `project:edit` |

## 5. 供应商 `/suppliers`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/suppliers` | 列表（分页、关键词、状态） | `supplier:view` |
| GET | `/suppliers/options` | 下拉（仅启用，按 `supplier.share.scope` 决定是否项目隔离） | `supplier:view` `contract:edit` `daily:edit` `repayment:edit` |
| GET | `/suppliers/export` · GET `/suppliers/template` | 导出 Excel / 模板 | `supplier:view` |
| GET | `/suppliers/:id` | 详情 | `supplier:view` |
| POST | `/suppliers` | 新增（名称唯一校验） | `supplier:edit` |
| PUT | `/suppliers/:id` | 修改 | `supplier:edit` |
| DELETE | `/suppliers/:id` | 删除（被合同引用只可停用） | `supplier:edit` |
| POST | `/suppliers/:id/toggle` | 启用/停用 | `supplier:edit` |
| POST | `/suppliers/import` | 导入 Excel | `supplier:edit` |

> 项目隔离：`projectId = null` 为全局共享；`supplier.share.scope = PROJECT` 时按项目过滤。

## 6. 分包商 `/subcontractors`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/subcontractors` | 列表 | `subcontractor:view` |
| GET | `/subcontractors/options` | 下拉 | `subcontractor:view` |
| GET | `/subcontractors/:id` | 详情 | `subcontractor:view` |
| GET | `/subcontractors/:id/letter` | 材料员授权委托书（生成/下载） | `subcontractor:view` |
| GET | `/subcontractors/:id/letter-filename` | 委托书文件名 | `subcontractor:view` |
| POST | `/subcontractors/preview` | 委托书预览（未落库） | `subcontractor:view` |
| POST | `/subcontractors` | 新增 | `subcontractor:edit` |
| PUT | `/subcontractors/:id` | 修改 | `subcontractor:edit` |
| POST | `/subcontractors/:id/complete` | 完成（编辑中 → 已完成） | `subcontractor:edit` |
| POST | `/subcontractors/export-mark` | 导出签章标记 | `subcontractor:edit` |
| DELETE | `/subcontractors/:id` | 删除 | `subcontractor:edit` |

> 关联：`subcontractId` 指向分包合同（`Contract`），已建立真实外键（`onDelete: SetNull`）。

## 7. 合同 `/contracts`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/contracts` | 列表（编号/名称/类型/供应商/执行情况/状态筛选） | `contract:view` |
| GET | `/contracts/options` | 下拉（当前项目） | `contract:view` `daily:edit` `settlement:edit` `payment:edit` `invoice:edit` `repayment:edit` |
| GET | `/contracts/check-code` | 编号实时查重（`code`、`excludeId`） | `contract:view` `contract:edit` |
| GET | `/contracts/next-code` | 生成下一个合同编号 | `contract:view` |
| GET | `/contracts/name-preview` | 合同名称预览（按编号规则拼装） | `contract:view` |
| GET | `/contracts/drafts` | 草稿列表（合同起草） | `contract:view` |
| GET | `/contracts/published` | 已发布（待签章/已签章）列表——「合同查询」 | `contract:view` |
| GET | `/contracts/template` | 导出用空白模板 | `contract:view` |
| GET | `/contracts/:id` | 详情（含供应商、扩展信息、附件） | `contract:view` |
| GET | `/contracts/:id/changes` | 变更记录 | `contract:view` |
| GET | `/contracts/:id/ext` · PUT `/contracts/:id/ext` | 台账补充字段（双向） | view / `contract:edit` |
| POST | `/contracts` | 新增（编号查重 + 字典校验） | `contract:edit` |
| PUT | `/contracts/:id` | 修改（记录变更日志） | `contract:edit` |
| DELETE | `/contracts/:id` | 删除（仅草稿） | `contract:edit` |
| DELETE | `/contracts/drafts/:id` | 删除草稿 | `contract:view` |
| POST | `/contracts/:id/publish` | 提交（草稿 → 待签章） | `contract:edit` |
| PUT | `/contracts/:id/status` | 直接置状态 | `contract:edit` |
| POST | `/contracts/:id/reject` | 驳回回合同起草（仅待签章/已签章可驳回） | `contract:edit` |
| POST | `/contracts/:id/sign` | 签章（上传签章件，记录签订日期） | `contract:edit` |
| GET | `/contracts/:id/signed-file` | 下载签章合同 | `contract:view` |
| GET | `/contracts/:id/export-word` | 导出 Word（变量替换后的正文） | `contract:view` |
| GET | `/contracts/:id/material-pool` · POST · DELETE `/:poolId` | 合同物资池（起草期候选物资） | view / edit / edit |
| GET | `/contracts/:id/draft-materials` · POST · PUT · DELETE `/:rowId` | 起草期合同物资清单 | view / edit / edit / edit |
| GET | `/contracts/:id/next-supplement-code` | 下一个补充协议编号 | `contract:view` |
| POST | `/contracts/import` | 导入 Excel | `contract:edit` |

## 8. 合同模板与条款 `/templates`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/templates` | 模板列表（`keyword` / `categoryCode` / `includeHistory` / 分页） | `template:view` |
| GET | `/templates/:id` | 详情（含变量 `variables`） | `template:view` |
| POST | `/templates` | 新增（生成 v1；`status` 接受 0/1 与历史 Y/N，服务端归一） | `template:edit` |
| PUT | `/templates/:id` | 修改并生成新版本（**沿用提交的状态**；旧版本停用；乐观锁 `version`） | `template:edit` |
| DELETE | `/templates/:id` | 删除**整条版本链**（与界面文案一致） | `template:edit` |
| POST | `/templates/:id/toggle` | 启用/停用 | `template:edit` |
| GET | `/templates/:id/versions` | 版本列表 | `template:view` |
| POST | `/templates/:id/rollback` | 回滚到指定版本 | `template:edit` |
| GET | `/templates/guide/categories` | 起草向导步骤三：可用模板分类（`isFramework`/`isSupplement`/`contractType`） | `template:view` |
| POST | `/templates/guide/generate` | 按模板 + 合同 + 供应商生成合同正文（变量替换） | `template:edit` |
| GET | `/templates/clauses` | 条款库列表 | `template:view` |
| POST | `/templates/clauses` | 新增条款（technical/quality/payment/acceptance） | `template:edit` |
| PUT | `/templates/clauses/:id` · DELETE `/templates/clauses/:id` | 修改 / 删除条款 | `template:edit` |

> **占位符语法规范**：模板**只支持双花括号 `{{变量名}}`**（表格占位符 `{{物料编码清单}}` / `{{合同清单}}` 同类）。
> 合同模板与单据模板**共用 `ContractTemplate` 表**：`GET /templates` 会排除 `doc_template_category`
> 里的分类（否则「付款单/结算单」会出现在合同模板列表里）。
> 单花括号 `{变量名}` 与英文遗留 key（`MATERIAL_CODE_TABLE`、`CONTRACT_ITEM_TABLE`）的支持**已移除**
> （2026-10-14，本项目无存量业务数据；存量模板内容已由迁移 `20261018000000_canonicalize_template_placeholders` 规范化），
> 原「一键迁移」接口 `POST /templates/migrate` 一并下线。
> 采购文档的变量体系另见
> [.claude/rules/procurement-and-tender.md](../.claude/rules/procurement-and-tender.md)「三套变量体系」。

## 8.1 单据模板 `/doc-templates`

基础信息管理 →「单据模板」（业务口径 2026-10-17）：五类单据的 **Excel 模板**
—— **结算单 / 总结算单 / 保理单 / 逾期利息 / 付款单**（模板文件为上传的 `.xlsx`）。

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/doc-templates` | 列表（`?keyword=` 名称关键词、`?categoryCode=` 按分类筛、`?status=` 0/1；默认只列五类单据） | `template:view` |
| GET | `/doc-templates/:id` | 详情（`fileUrl` 返回**相对存储键**，前端展示时补一次 `/api/files/` 前缀） | `template:view` |
| POST | `/doc-templates` | 新增（**分类走字典 `doc_template_category`**；必须上传 `.xlsx`，服务端校验存在性与可解析性） | `template:edit` |
| PUT | `/doc-templates/:id` | 修改（沿用乐观锁 `version`；换文件时重新校验） | `template:edit` |
| DELETE | `/doc-templates/:id` | 删除 | `template:edit` |
| GET | `/doc-templates/render/payment-procedure/:procedureId` | **渲染付款单 Excel**（`?templateId=` 可指定模板，不传则取启用中的「付款单」模板） | `template:view` |

> 存储**复用 `ContractTemplate` 表**，但分类走独立字典 `doc_template_category`（混用会让合同模板的
> 分类下拉里冒出"付款单"）。**付款单与总结算单已接生成路径**，其余三类先做模板存放与编辑。
> 模板文件**只接受 `.xlsx`**（`.xlsm` 的宏在 ExcelJS 写出时会丢失）；`fileUrl` 落库为
> `StorageService` 相对键（上传接口同时返回 `key` 与 `url`，前端落库用 `key`）。
> 变量体系见 `server/src/modules/doc-template/doc-template-vars.ts` 与
> `web/src/constants/docVariables.ts`（互为镜像，由 `docVariables.spec.mts` 锁定）；
> `{{结算明细表}}` 是**表格占位符**：整格独占时按行展开，与文字混排时退化为多行文本。

## 9. 采购任务 `/procurement-tasks`

权限：读 `contract:view` / 写 `contract:edit`（采购工作流归属合同域）。
**阶段链单一事实源**：后端 `src/constants/procurementFlow.ts` 与前端 `web/src/constants/procurementWorkflow.ts` 互为镜像，由 `server/test/frontendChainParity.spec.mts` 锁定。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/procurement-tasks` | 列表（可按 `module` 带出对应阶段模块数据） |
| POST | `/procurement-tasks` | 采购发起（新建任务） |
| GET | `/procurement-tasks/:id` | 详情（含阶段链 `stages`、`contractId` 派生值） |
| PUT | `/procurement-tasks/:id` | 修改基本信息（须处于可编辑状态） |
| DELETE | `/procurement-tasks/:id` | 删除任务 |
| POST | `/procurement-tasks/:id/publish` | **发布当前阶段**（阶段门禁 + 全部完成后自动生成关联合同） |
| POST | `/procurement-tasks/:id/sync-contract-status` | 同步合同阶段状态 |
| DELETE | `/procurement-tasks/:id/modules/:moduleKey` | 删除某阶段模块数据 |
| GET/PUT | `/procurement-tasks/:id/total-list` | 总采购清单 |
| GET/PUT | `/procurement-tasks/:id/pre-meeting-minutes` | 采前会会议纪要（单项采购 ≥100 万） |
| GET/PUT | `/procurement-tasks/:id/notice` | 采购公告 |
| GET/PUT | `/procurement-tasks/:id/document` | 采购文件 |
| GET/PUT | `/procurement-tasks/:id/result-report` | 成交报告 |
| POST | `/procurement-tasks/:id/result-report/import` | 导入「响应单位情况汇总表」 |
| GET | `/procurement-tasks/:id/result-report/template` | 成交报告导入模板 |
| POST | `/procurement-tasks/:id/reject-result-report` | 成交报告退回 → 重发（回退阶段并清理草稿合同） |
| GET | `/procurement-tasks/:id/bidders` | 结构化投标/响应单位 + 评标记录（读取时对存量 JSON 快照做幂等回填） |
| PUT | `/procurement-tasks/:id/bidders` | 保存投标单位（状态 / 投标文件 / 最终确认价 / 备注；单位与报价来自导入表） |
| PUT | `/procurement-tasks/:id/evaluations` | 保存评标记录（**全量替换**：评委 / 得分 / 排名 / 结论 / 备注 / 评标时间） |
| GET/PUT | `/procurement-tasks/:id/price-compare` | 采购价格对比表 |
| GET/PUT | `/procurement-tasks/:id/framework-explanation` | 框架协议事前说明 |
| POST | `/procurement-tasks/:id/framework-explanation/import-price-compare` | 导入价格对比数据 |
| GET | `/procurement-tasks/:id/contract-template` | 导出合同模板所需数据（模板内容 + 技术质量/验收/付款标准） |

> 关联：采购任务 ↔ 合同**只由 `Contract.taskId` 一条表达**（任务侧无冗余 `contractId` 字段）；
> 详情的 `contractId` 为**派生值**（该任务生成时间最早的主合同）。

## 10. 采购模板 `/procurement-templates`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/procurement-templates` | 列表（`keyword` 匹配名称/标签、`moduleType`、`status` 0/1、`page`/`pageSize`；返回 `{ list, total, page, pageSize }`） | `template:view` |
| GET | `/procurement-templates/:id` | 详情（含变量） | `template:view` |
| POST | `/procurement-templates` | 新增（**全项目通用**；同 `moduleType` 覆盖旧模板并写版本快照；`status` 只接受 0/1） | `template:edit` |
| PUT | `/procurement-templates/:id` | 修改（乐观锁 `version`；换 `moduleType` 时快照并删除冲突模板） | `template:edit` |
| DELETE | `/procurement-templates/:id` | 删除（版本快照级联删除） | `template:edit` |
| GET | `/procurement-templates/:id/versions` | 版本历史（新→旧） | `template:view` |
| POST | `/procurement-templates/:id/rollback` | 回滚（body `{ versionId }`，基于快照创建新版本） | `template:edit` |

> `moduleType`：`INITIATE` / `PRE_MEETING` / `NOTICE` / `DOCUMENT` / `RESULT_REPORT` / `PRICE_COMPARE` / `FRAMEWORK`。
> 其中 `INITIATE`（采购发起）不产出 Word 文档，无可用变量。
> 导出只使用**启用中**（`status = 1`）的模板；显式指定的模板已停用时降级为模块内置文档。

## 11. 物资 `/materials` · `/contract-materials`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/materials` | 物资基础库列表 | `material:view` |
| GET | `/materials/options` | 下拉 | `material:view` |
| GET | `/materials/export` · GET `/materials/template` | 导出 / 模板 | `material:view` |
| POST | `/materials` | 新增（`name + spec` 唯一） | `material:edit` |
| PUT | `/materials/:id` | 修改 | `material:edit` |
| POST | `/materials/:id/toggle` | 启用/停用（软删除） | `material:edit` |
| DELETE | `/materials/:id` | 删除（被合同物资清单引用时禁止，须改用停用） | `material:edit` |
| POST | `/materials/import` | 导入 Excel | `material:edit` |
| GET | `/contract-materials` | 合同物资清单（按 `contractId`） | `material:view` |
| GET | `/contract-materials/all` | 全部（跨合同） | `material:view` |
| GET | `/contract-materials/template` · GET `/contract-materials/export` | 模板 / 导出 | `material:view` |
| POST | `/contract-materials` | 新增清单行 | `material:edit` |
| PUT | `/contract-materials/:id` | 修改（变更后自动重派生结算台账） | `material:edit` |
| PUT | `/contract-materials/sort` | 行号批量重排 | `material:edit` |
| DELETE | `/contract-materials/:id` | 删除 | `material:edit` |
| POST | `/contract-materials/derive` | 由物资基础库派生清单行 | `material:edit` |
| POST | `/contract-materials/import` | 导入 Excel | `material:edit` |

## 12. 日报 `/daily-reports`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/daily-reports` | 列表（账期、合同、供应商、材料类别筛选；关键词命中 `materialName`/`receiptNo`/`plateNo`） | `daily:view` |
| GET | `/daily-reports/material-types` | 物资种类联动（读字典 `extField1`） | `daily:view` |
| GET | `/daily-reports/contract-settled-qty` | 按合同汇总已结算数量 | `daily:view` |
| GET | `/daily-reports/export` | 导出 Excel（按台账列顺序） | `daily:view` |
| GET | `/daily-reports/:id` | 详情 | `daily:view` |
| POST / PUT / DELETE | `/daily-reports[/:id]` | CRUD | `daily:edit` |
| POST | `/daily-reports/import` | 导入 Excel | `daily:edit` |

> 关联：收领单推送产生的日报由 `receiptOrderId`（真实外键，`onDelete: SetNull`）关联；
> `receiptNo` 仅为编号快照，用于展示与导入导出，**不再用于匹配**。

## 13. 收领单 `/receipt-orders`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/receipt-orders` | 列表 | `receipt:view` |
| GET | `/receipt-orders/next-no` | 生成下一个收领单编号 | `receipt:view` |
| GET | `/receipt-orders/contract-materials` | 按合同带出物资明细 | `receipt:view` |
| GET | `/receipt-orders/party-options` | 供应/领用单位候选 | `receipt:view` |
| GET | `/receipt-orders/receiving-unit-options` | 领用单位候选（多态） | `receipt:view` |
| GET | `/receipt-orders/subcontractor-contracts` | 分包合同候选 | `receipt:view` |
| GET | `/receipt-orders/:id` | 详情（含明细） | `receipt:view` |
| POST | `/receipt-orders` | 新增（保存后自动入资产台账、推送总日报） | `receipt:edit` |
| PUT | `/receipt-orders/:id` | 修改（明细全量覆盖；同步资产台账） | `receipt:edit` |
| POST | `/receipt-orders/:id/push` | 重新推送总日报 | `receipt:edit` |
| DELETE | `/receipt-orders/:id` | 删除（明细与资产台账级联删除；日报保留并解除关联） | `receipt:edit` |

## 14. 资产台账 `/assets`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/assets` | 列表（进/出场记录 + 在用/闲置/报废/丢失四态） | `asset:view` |
| GET | `/assets/export` · GET `/assets/template` | 导出 / 模板 | `asset:view` |
| POST | `/assets` | 新增 | `asset:edit` |
| PUT | `/assets/:id` | 修改（金额由服务端计算） | `asset:edit` |
| DELETE | `/assets/:id` | 删除 | `asset:edit` |
| POST | `/assets/import` | 导入 Excel | `asset:edit` |

## 15. 结算 `/settlements`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/settlements` | 结算单列表 | `settlement:view` |
| GET | `/settlements/:id` | 详情 | `settlement:view` |
| POST | `/settlements` | 新增 | `settlement:edit` |
| PUT | `/settlements/:id` | 修改 | `settlement:edit` |
| POST | `/settlements/:id/reject` | 驳回回填 | `settlement:edit` |
| DELETE | `/settlements/:id` | 删除 | `settlement:edit` |
| GET | `/settlements/ledger` | 结算台账列表 | `settlement:view` |
| GET | `/settlements/ledger/:id` | 台账详情 | `settlement:view` |
| GET | `/settlements/ledger/export` · GET `/settlements/ledger/template` | 导出 / 模板 | `settlement:view` |
| POST | `/settlements/ledger` | 新增台账行 | `settlement:edit` |
| PUT | `/settlements/ledger/:id` | 修改 | `settlement:edit` |
| DELETE | `/settlements/ledger/:id` | 删除 | `settlement:edit` |
| POST | `/settlements/ledger/refresh` | 按合同重派生台账 | `settlement:edit` |
| POST | `/settlements/ledger/import` | 导入 Excel | `settlement:edit` |
| GET | `/settlements/generate/preview` | 预览「上一期」待生成情况（未挂结算单的收领单张数 / 还差几个合同；`?refDate=` 可指定参照日） | `settlement:view` |
| POST | `/settlements/generate` | **生成本期（默认上一期）结算单**：抓该期未挂结算单的收领单，按物资合同各出一张**草稿**（幂等，已有结算单的合同跳过并补挂迟到的收领单）；`refDate` / `contractId` 可选 | `settlement:edit` |
| GET | `/settlements/compliance-sheet` | 合规性问题清单 | `settlement:view` |

## 15.1 总结算单 `/final-settlements`

结算及付款管理 →「总结算单」（业务口径 2026-10-16）：抓取该合同**全部月度结算**生成，
附件上传到位即「已结算」——此时合同执行情况置 `DONE_SETTLED`（已完已结），**付款比例切到 100%**。

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/final-settlements` | 列表（`?contractId=` / `?statusCode=` / `?keyword=`，含明细） | `settlement:view` |
| GET | `/final-settlements/:id` | 详情（含明细行） | `settlement:view` |
| POST | `/final-settlements/generate` | **生成**（body `contractId`）：抓非草稿月度结算 → 明细快照 + 合计；**一个合同只允许一张**（重复 400），无月度结算也 400 | `settlement:edit` |
| PUT | `/final-settlements/:id` | 修改备注（**状态不经此直传**，只由上传附件驱动） | `settlement:edit` |
| POST | `/final-settlements/:id/attach` | **上传附件 → 已结算**：写附件 + 状态 `SETTLED` + 合同 `execStatus = DONE_SETTLED` + 重算付款比例（→ 100%） | `settlement:edit` |
| DELETE | `/final-settlements/:id` | 删除；**已结算的删掉会把合同执行情况与比例一并回退**（不留无单据支撑的"已完已结"） | `settlement:edit` |
| GET | `/final-settlements/:id/export` | 导出 Word（模板分类 `FINAL_SETTLEMENT`，明细走表格占位符 `{{结算明细表}}`；`?templateId=` 可指定） | `settlement:view` |

> 明细与合计是**生成时的快照**：月度结算事后被改，不回头改已出的总结算单（要更新就删掉重生成）。
> 附件经 `POST /files/upload` 落盘后传回 URL（落盘唯一入口是 `StorageService`）。

## 16. 付款 `/payments`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/payments/records` | 付款记录（付款台账） | `payment:view` |
| GET | `/payments/records/export` · GET `/payments/records/template` | 导出 / 模板 | `payment:view` |
| POST | `/payments/records` | 新增 | `payment:edit` |
| PUT | `/payments/records/:id` | 修改 | `payment:edit` |
| DELETE | `/payments/records/:id` | 删除 | `payment:edit` |
| POST | `/payments/records/import` | 导入 Excel | `payment:edit` |

> 付款计划 / 付款申请 / 核销端点**已移除**，统一收敛为单表 `/payments/records`。

## 16.1 付款手续 `/payment-procedures`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/payment-procedures` | 付款手续列表（按合同 / 供应商 / 关键词 / 付款日期区间筛选） | `payment:view` |
| GET | `/payment-procedures/:id` | 详情 | `payment:view` |
| POST | `/payment-procedures` | 编制（**合同必填**；开累结算 / 开累付款 / 未付款三值由服务端按合同链口径取数并**快照**，不接受前端直传） | `payment:edit` |
| PUT | `/payment-procedures/:id` | 修改（换合同时按新合同重取三值；不换则保留原快照） | `payment:edit` |
| DELETE | `/payment-procedures/:id` | 删除 | `payment:edit` |

> 权限复用付款管理的 `payment:view` / `payment:edit`（同一批人管，不新开权限码）。
> ⚠️ 付款单的 **Word 导出**待「单据模板」模块落地后接入。

## 17. 发票 `/invoices`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/invoices` | 收票登记（发票台账） | `invoice:view` |
| GET | `/invoices/check-no` | 发票号码查重（项目内） | `invoice:view` `invoice:edit` |
| GET | `/invoices/export` · GET `/invoices/template` | 导出 / 模板 | `invoice:view` |
| GET | `/invoices/:id` | 详情 | `invoice:view` |
| POST / PUT / DELETE | `/invoices[/:id]` | CRUD | `invoice:edit` |
| POST | `/invoices/:id/verify` | 标记为「已查验」（**登记核对**用：录入并核对该发票信息后手动标记；**不做验真**，不接第三方查验服务） | `invoice:edit` |
| POST | `/invoices/recognize` | 发票 OCR/二维码识别 | `invoice:edit` |
| POST | `/invoices/batch` | 批量登记 | `invoice:edit` |
| POST | `/invoices/import` | 导入 Excel | `invoice:edit` |

## 18. 资金费用 `/finance`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/finance/contract-params/:contractId` | 合同的资金参数（付款模式/月利率/宽限天数/利息上限） | `finance:view` |
| PUT | `/finance/contract-params/:contractId` | 保存资金参数 | `finance:edit` |
| GET | `/finance/factoring-costs` | 保理费用台账 | `finance:view` |
| GET | `/finance/factoring-costs/export` | 导出 | `finance:view` |
| POST / PUT / DELETE | `/finance/factoring-costs[/:id]` | CRUD | `finance:edit` |
| GET | `/finance/overdue-interests` | 逾期利息台账 | `finance:view` |
| GET | `/finance/overdue-interests/export` | 导出 | `finance:view` |
| POST | `/finance/overdue-interests/generate` | 按合同 + 结算月生成逾期利息 | `finance:edit` |
| POST / PUT / DELETE | `/finance/overdue-interests[/:id]` | CRUD | `finance:edit` |

> 项目隔离：按 `contractId` 归属（合同已在项目内），**查询不带 `projectId` 过滤**——这是有意例外。

## 19. 合同台账 `/ledger`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/ledger/contracts` | 台账数据（36 列，批量聚合 + 合规性问题计算） | `ledger:view` |
| GET | `/ledger/columns` | 列配置（默认显隐） | `ledger:view` |
| PUT | `/ledger/columns` | 保存列显隐配置（存 `sys_param: ledger.columns.config`） | `ledger:view` |
| GET | `/ledger/summary` | 台账汇总指标（合同额/结算/付款/发票） | `ledger:view` |
| GET | `/ledger/export` | 导出 Excel（按当前列配置） | `ledger:view` |

## 20. 还款协议 `/repayments`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/repayments` | 列表（协议编号、供应商、签订日期筛选） | `repayment:view` |
| GET | `/repayments/suggest-code` | 建议协议编号 | `repayment:edit` |
| GET | `/repayments/check-code` | 编号查重 | `repayment:edit` |
| GET | `/repayments/export` | 导出 Excel | `repayment:view` |
| GET | `/repayments/:id` | 详情（含明细） | `repayment:view` |
| POST | `/repayments` | 新增（主表 + 至少一条明细，编号项目内唯一） | `repayment:edit` |
| PUT | `/repayments/:id` | 修改（明细整体覆盖） | `repayment:edit` |
| DELETE | `/repayments/:id` | 删除 | `repayment:edit` |

## 21. 通知 `/notifications`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/notifications` | 列表（未读优先） | — |
| GET | `/notifications/unread-count` | 未读数 | — |
| POST | `/notifications/:id/read` · POST `/notifications/read-all` | 标记已读 | — |
| POST | `/notifications/send` | 发送站内信（**唯一实现的通道**；邮件/短信/企微/钉钉为接口预留） | — |

## 22. 看板 `/dashboard`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/dashboard/overview` | 关键指标卡（合同数/合同额/结算额/付款额/发票额/待办） | — |
| GET | `/dashboard/trend` | 收付款与结算趋势（按月） | — |
| GET | `/dashboard/contract-type` | 合同类型分布 | — |
| GET | `/dashboard/invoice-stats` | 发票统计（按类型/状态） | — |
| GET | `/dashboard/reminders` | 到期/逾期/付款提醒 | — |

## 23. 系统管理 `/system`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET/POST | `/system/users` | 用户列表 / 新增（含角色） | `system:user` |
| PUT/DELETE | `/system/users/:id` | 修改 / 删除 | `system:user` |
| POST | `/system/users/:id/reset-password` | 重置密码 | `system:user` |
| GET/POST | `/system/roles` | 角色列表 / 新增（含权限分配） | `system:user` |
| PUT/DELETE | `/system/roles/:id` | 修改 / 删除 | `system:user` |
| GET | `/system/permissions` | 权限树（按模块） | `system:user` |
| GET/PUT | `/system/params` | 系统参数（编号唯一性策略、供应商共享范围等） | `system:config` |
| GET | `/system/logs/operations` | 操作日志 | `system:log` |
| GET | `/system/logs/logins` | 登录日志 | `system:log` |

> `/system/depts`（部门管理）**已移除**：系统无部门模型；行级数据权限已明确**不做**（业务 2026-10-17 确认）。

## 24. 文件 `/files`

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/files/upload` | 单/多文件上传（返回 url；落盘统一走 `common/services/storage.service.ts` 的 `StorageService`，将来可换成对象存储实现） | — |
| GET | `/files/*` | 静态文件访问（`useStaticAssets(UPLOAD_DIR, '/api/files')`） | — |

---

## 附录 · 核对命令（只读）

```bash
# 1) 全部路由（以 controller 为准，与本文件逐条对应）
cd server && grep -rnE "@(Controller|Get|Post|Put|Delete|Patch)\(" src/modules --include=*.controller.ts

# 2) 权限码与路由的对应关系
cd server && grep -rn "@RequirePermissions" src/modules --include=*.controller.ts

# 3) 确认已移除端点不再存在（应无输出）
cd server && grep -rnE "depts|payments/plans|payments/applies|payments/verifications|invoices/applies|approvals" src/

# 4) 项目上下文读取点（应为各 controller 的 @ProjectId()）
cd server && grep -rn "@ProjectId()" src/modules --include=*.controller.ts | wc -l
```

> 维护约定：新增/删除路由时同步更新本文件；`docs/03` 与 controller 不一致即视为文档缺陷。
