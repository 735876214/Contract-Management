# 本地文件存储结构（附件只存本地）

迁移脚本只搬**能确定项目归属**的引用（合同签章件、合同附件、收领单扫描、发票图片、付款凭证、
总结算附件、投标文件、分包证件/授权书，以及考察照片/询价单/框架说明等 JSON 附件）；
合同模板文件、导入错误报告属全局资源，保持原键不动（读取端按「无项目」放行）。

> **决策**：本项目附件**只保存在本地磁盘**，不引入 S3/MinIO 等对象存储（业务 2026-10-18 确认）。
> 本文记录目录结构、命名规则、数据库字段映射、读写路径、生命周期与审计方式。

## 1. 存储根目录

| 环境 | 容器内 `UPLOAD_DIR` | 宿主机实际路径 |
|---|---|---|
| 本机直跑 `npm run start:dev` | `./uploads`（默认） | `<repo>/server/uploads` |
| dev compose | `/data/uploads` | `<repo>/data-dev/uploads`（`./data-dev:/data`） |
| 生产单容器 | `/data/uploads` | NAS `/volume1/docker/cms/data/uploads`（`/volume1/docker/cms/data:/data`） |

- `resolveUploadRoot()`：空值回退 `./uploads`，相对路径按 `process.cwd()` 解析。
- `deploy/single/start.sh` 启动时 `mkdir -p "${UPLOAD_DIR:-/data/uploads}"`；服务启动时
  `StorageService.ensureRoot()` 也会兜底创建。

## 2. 目录树与命名

```
<UPLOAD_DIR>/
├── p/                                        # 项目命名空间（2026-11-19 审计 P1 起）
│   └── <projectId>/
│       ├── 2026-11/                          # 通用上传：默认子目录 = 上传当月 YYYY-MM
│       │   ├── 1730000000000-ab12cd34.pdf    # 合同附件、发票图片、收领单扫描、
│       │   └── 1730000000123-ef56ab78.png    # 分包证件、投标文件、单据模板、考察照片…
│       ├── signed/                           # 合同签章件（projectScopedSub(projectId,'signed')）
│       │   └── 1730000000456-cd34ef12.pdf
│       └── ai-analytics/                     # AI 工作簿（projectScopedSub(projectId,'ai-analytics')）
│           └── <标题>.xlsx
├── 2026-10/                                  # 历史键（无项目前缀）：2026-11-19 之前上传的存量
├── signed/                                   # 历史键：2026-11-19 之前签的章
├── ai-analytics/                             # 历史键：sub='ai-analytics/<projectId>'
│   └── <projectId>/<标题>.xlsx
└── import-errors/                            # 导入错误报告（固定文件名，系统级、无项目归属）
    └── import-errors-<taskId>.xlsx
```

- 键 = **相对 POSIX 路径**（`/` 分隔，不含根目录/盘符），落库与 URL 都基于它。
- 文件名 = `<epochMillis>-<8位base36随机串><ext>`；`import-errors` 用固定名。
- **一级目录是归属信息**：`p/<projectId>/…` 的键在下载时被 `FileServeController.projectIdOfStorageKey()`
  解析出项目并复核调用方是否为该项目成员（超管放行）。
  存量键（`signed/…`、`YYYY-MM/…`）**不再默认「登录即可读」**：读取时用 `modules/file/legacy-key-owner.ts`
  反查数据库里谁引用这个键，推出归属项目后照样按成员校验；查不到引用即「归属不明」→ 403，
  并提示执行 `server/scripts/storage-migrate.mjs` 迁移。全局资源（合同模板文件、未绑项目的导入错误文件）
  反查结果为「无项目」，登录即可读。因此在同一个桶里不要混放不同项目的文件，新代码一律走 `projectScopedSub()`。
- 键安全：`assertSafeStorageKey` 拒绝空、绝对路径/盘符/UNC、任何 `..` 段（400）。

## 3. 写入路径（统一走 `StorageService.save()`）

| 入口 | 子目录/命名 | 落库 |
|---|---|---|
| `POST /api/files/upload`（通用上传） | `p/<projectId>/YYYY-MM/<自动名>`（请求带项目上下文时；否则退回 `YYYY-MM/`） | 返回 `{fileName,url,key,size}`，业务自行保存 url 或 key |
| 合同签章 `POST /contracts/:id/sign` | `p/<projectId>/signed/<自动名>` | `Contract.signedFilePath = key` |
| 导入错误报告 | `import-errors/import-errors-<taskId>.xlsx` | `ImportTask.errorFileUrl = url` |
| 经营数据助手工作簿 `POST /ai/analytics/workbook` | `p/<projectId>/ai-analytics/<标题>.xlsx` | `AiAnalyticsReport.workbookKey = key`；下载走 `GET /ai/analytics/:id/workbook` |

上传限制（2026-10-18 起）：单请求最多 10 个文件、单文件 ≤ 50MB（与 nginx 一致）；
拒绝 `.html/.htm/.svg/.js/.mjs/.exe/.bat/.sh/.ps1/.php/.jsp/.jar` 等可执行/可脚本类型，
避免公开静态服务下的存储型 XSS。业务常见格式（pdf/office/图片/zip/rar/7z/txt/csv/dwg 等）不受影响。

## 4. 数据库中的文件引用

**相对键（读取经 `StorageService`）**

| 业务 | 字段 | 备注 |
|---|---|---|
| 合同签章件 | `Contract.signedFilePath` | `p/<projectId>/signed/<file>`（2026-11-19 前为 `signed/<file>`）；下载走 `/contracts/:id/signed-file` |
| 收领单扫描件 | `ReceiptOrder.scanUrl` | 保存时归一为键 |
| 单据模板 xlsx | `ContractTemplate.fileUrl` | 创建/更新归一为键；历史 URL 读取兼容 |
| 经营数据助手工作簿 | `AiAnalyticsReport.workbookKey` | `p/<projectId>/ai-analytics/<标题>.xlsx`（旧为 `ai-analytics/<projectId>/…`）；删除记录只删 DB，文件留给存储审计 |

**`/api/files/...` URL 或 JSON 内 URL**

| 业务 | 字段 |
|---|---|
| 合同附件 | `ContractAttachment.url` |
| 总结算附件 | `FinalSettlement.attachmentUrl` |
| 发票图片 | `Invoice.imageUrl` |
| 分包授权 | `LaborAuthLedger.idCardFront/idCardBack/signatureScreenshot/signedAuthFile` |
| 投标文件 | `ProcurementBidder.bidFileUrl` |
| 框架协议附表 | `FrameworkExplanation.attachments`（JSON `[{fileName,url,size}]`） |
| 采前会询价单 | `PreMeetingMinutes.inquirySheets`（JSON） |
| 考察报告照片 | `InspectionReport.photos`（JSON） |
| 付款回单 | `PaymentRecord.receiptUrl` |
| 导入错误报告 | `ImportTask.errorFileUrl` |

统一归一：所有 URL / 键 / JSON 内 URL 都由
`server/src/common/utils/storage-url.ts` 的 `storageKeyFromUrl()` 解析为相对键；
归档、分包 Excel、收领单扫描件、单据模板共用这一份实现。

## 5. 读取路径

| 路径 | 实现 | 权限 |
|---|---|---|
| `GET /api/files/**` | `FileServeController`（`server/src/modules/file/file-serve.controller.ts`）先 `assertOwnership()` 复核归属，再代理 `storage.read()`，支持单段 Range（206） | **需登录**（`JwtAuthGuard`；Bearer 或 httpOnly Cookie，GET 接受 Cookie）；键为 `p/<projectId>/…` 时**还须是该项目成员**（超管放行，否则 403「无权访问该项目」）。历史键（无前缀）走 `resolveLegacyKeyOwner()` 反查归属：有项目 → 同样按成员校验；无项目（全局资源）→ 登录即可；查不到引用 → 403 |
| `GET /contracts/:id/signed-file` | `storage.exists` + `storage.read`，Buffer 返回并设 `attachment` | `contract:view` |
| `GET /archive/download` | 逐文件读取/图片转 PDF，`archiver` 流式打包（内存只留当前文件） | `archive:view` |
| 单据模板生成 | 读取 xlsx 模板后渲染 | 各生成端点权限 |
| 分包授权 Excel | 读取证件/签章图片嵌入表格 | `labor:view` |

注意：`storage.read()` 找不到文件 → **400**（“文件不存在或已被清理”）；静态 URL 找不到 → **404**。

## 6. 生命周期与审计

- **不自动删除文件**（业务 2026-10-18 选择“审计 + 人工清理”，避免不可恢复的数据丢失）。
- 重新签章、驳回回草稿、删除业务行都会让旧文件失去引用，成为孤儿文件。
- 审计脚本（**只读，不删除**）：

```bash
cd server
npm run build
DATABASE_URL="postgresql://cms:cms123456@localhost:15432/cms?schema=public" \
UPLOAD_DIR="/data/uploads" node scripts/storage-audit.mjs
```

输出：
- **缺失引用**（库里有、磁盘无）——下载会失败，需要恢复文件或修正数据；
- **孤儿文件**（磁盘有、库里无）——人工确认后可删除；
- **重复引用**（同一键多条记录，信息项）；
- **非法引用**（`..`、绝对路径等）。

可选参数：`--json`（机器可读）、`--limit=50`（每类展示条数）、`--strict`（有 missing/orphans 时退出码 1）。

## 7. 备份与恢复

- `scripts/backup.sh`：`pg_dump` + 对 `DATA_DIR`（默认 `${CMS_DIR}/data`）做 `rsync --link-dest` 增量；
  **附件就在该目录下**，必须与数据库一起备份/恢复。
- `scripts/restore.sh`：恢复数据库 + 反向 rsync 文件目录。
- 迁移机器：直接复制 `UPLOAD_DIR` 即可；键是相对路径，换挂载点不影响库里的引用。
- 注意大小写差异：服务端生成的文件名全小写；手工放文件需保持一致。

## 8. 排障命令

```bash
docker compose exec server du -sh /data/uploads /data/uploads/*
find /data/uploads -type f | wc -l
find /data/uploads/2026-10 -type f | wc -l

# 某合同的签章件键（访问 URL = /api/files/<键>）
psql -c 'SELECT id, code, "signedFilePath" FROM "Contract" WHERE code = $1;'

# 存量键迁移（先预演，确认后加 --apply）：把「能查出归属项目」的历史键搬到 p/<projectId>/
cd server && npm run build
DATABASE_URL="postgresql://..." UPLOAD_DIR="/data/uploads" node scripts/storage-migrate.mjs
DATABASE_URL="postgresql://..." UPLOAD_DIR="/data/uploads" node scripts/storage-migrate.mjs --apply
# 迁完再核对一遍（只读）
DATABASE_URL="postgresql://..." UPLOAD_DIR="/data/uploads" node scripts/storage-audit.mjs
```

迁移脚本只搬**能确定项目归属**的引用（合同签章件、合同附件、收领单扫描、发票图片、付款凭证、
总结算附件、投标文件、分包证件/授权书，以及考察照片/询价单/框架说明等 JSON 附件）；
合同模板文件、导入错误报告属全局资源，保持原键不动（读取端按「无项目」放行）。

## 9. 明确不做

- 不引入对象存储/CDN；不改变 `/api/files/<key>` 形态。
- 不自动清理文件；不做去重、版本管理、行级文件权限、病毒扫描。
- 多副本部署的共享文件问题未解决（本地盘仍是单机依赖）。
