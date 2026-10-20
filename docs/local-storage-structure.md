# 本地文件存储结构（附件只存本地）

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
├── 2026-10/                                  # 通用上传：默认子目录 = 上传当月 YYYY-MM
│   ├── 1730000000000-ab12cd34.pdf            # 合同附件、发票图片、收领单扫描、
│   └── 1730000000123-ef56ab78.png            # 分包证件、投标文件、单据模板、考察照片…
├── signed/                                   # 合同签章件（save sub='signed'）
│   └── 1730000000456-cd34ef12.pdf
└── import-errors/                            # 导入错误报告（固定文件名）
    └── import-errors-<taskId>.xlsx
```

- 键 = **相对 POSIX 路径**（`/` 分隔，不含根目录/盘符），落库与 URL 都基于它。
- 文件名 = `<epochMillis>-<8位base36随机串><ext>`；`import-errors` 用固定名。
- 所有业务附件共用“月份桶”，**不按项目/合同分目录**；业务归属只存在数据库里。
- 键安全：`assertSafeStorageKey` 拒绝空、绝对路径/盘符/UNC、任何 `..` 段（400）。

## 3. 写入路径（统一走 `StorageService.save()`）

| 入口 | 子目录/命名 | 落库 |
|---|---|---|
| `POST /api/files/upload`（通用上传） | `YYYY-MM/<自动名>`；内存接收后 `save()` | 返回 `{fileName,url,key,size}`，业务自行保存 url 或 key |
| 合同签章 `POST /contracts/:id/sign` | `signed/<自动名>` | `Contract.signedFilePath = key` |
| 导入错误报告 | `import-errors/import-errors-<taskId>.xlsx` | `ImportTask.errorFileUrl = url` |

上传限制（2026-10-18 起）：单请求最多 10 个文件、单文件 ≤ 50MB（与 nginx 一致）；
拒绝 `.html/.htm/.svg/.js/.mjs/.exe/.bat/.sh/.ps1/.php/.jsp/.jar` 等可执行/可脚本类型，
避免公开静态服务下的存储型 XSS。业务常见格式（pdf/office/图片/zip/rar/7z/txt/csv/dwg 等）不受影响。

## 4. 数据库中的文件引用

**相对键（读取经 `StorageService`）**

| 业务 | 字段 | 备注 |
|---|---|---|
| 合同签章件 | `Contract.signedFilePath` | `signed/<file>`；下载走 `/contracts/:id/signed-file` |
| 收领单扫描件 | `ReceiptOrder.scanUrl` | 保存时归一为键 |
| 单据模板 xlsx | `ContractTemplate.fileUrl` | 创建/更新归一为键；历史 URL 读取兼容 |

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
| `GET /api/files/**` | `FileServeController`（`server/src/modules/file/file-serve.controller.ts`）代理 `storage.read()`，支持单段 Range（206） | **需登录**（`JwtAuthGuard`；Bearer 或 httpOnly Cookie，GET 接受 Cookie） |
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
```

## 9. 明确不做

- 不引入对象存储/CDN；不改变 `/api/files/<key>` 形态。
- 不自动清理文件；不做去重、版本管理、行级文件权限、病毒扫描。
- 多副本部署的共享文件问题未解决（本地盘仍是单机依赖）。
