# 企业合同管理系统（CMS）

React 18 + TypeScript + Vite + Ant Design 5 + Zustand 前端，NestJS + Prisma + PostgreSQL 后端，JWT + RBAC 鉴权。

## 目录结构

```
cms/
├── docker-compose.yml        # PostgreSQL 数据库
├── docs/
│   ├── 01-需求确认摘要.md
│   ├── 02-数据库ER设计.md
│   └── 03-API接口清单.md
├── server/                   # NestJS 后端
│   ├── prisma/schema.prisma  # 全量数据模型
│   ├── prisma/seed.ts        # 初始化字典/角色/演示数据
│   └── src/modules/...       # 15 大业务模块
└── web/                      # React 前端
    └── src/...
```

## 快速开始

```bash
# 1. 启动数据库
cd cms && docker compose up -d

# 2. 后端
cd server
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate deploy   # 首次可用 npx prisma migrate dev
npm run seed
npm run start:dev           # http://localhost:3000/api

# 3. 前端
cd ../web
npm install
npm run dev                 # http://localhost:5173
```

默认账号：`admin / admin123`（超级管理员，拥有全部项目权限）；另有 `manager`、`staff` 演示账号（密码相同）。

## 目录结构说明

```
server/src/
├── common/            通用层：统一响应、异常过滤、装饰器、Excel、日志、系统参数
├── prisma/            全局 PrismaClient
└── modules/
    ├── auth/          JWT 登录、RBAC 权限守卫
    ├── dict/          字典类型/字典项、缓存、引用校验、导入导出
    ├── project/       项目管理与项目成员
    ├── supplier/      供应商库（合同创建自动带出）
    ├── contract/      合同 CRUD、编号查重、审批、变更留痕
    ├── template/      模板库、版本、条款库、生成向导
    ├── daily-report/  日报（物资种类按材料类别联动）
    ├── contract-item/ 合同清单
    ├── settlement/    结算单 + 结算台账
    ├── payment/       付款计划/申请/执行台账/核销/逾期
    ├── invoice/       收票登记、开票申请、查重查重、查验预留
    ├── ledger/        合同台账（聚合视图 + 合规性问题计算）
    ├── repayment/     还款协议 + 还款明细
    ├── approval/      审批流定义与审批中心
    ├── notification/  站内信（邮件/短信/企微接口预留）
    ├── dashboard/     看板统计
    └── system/        用户/角色/权限/部门/参数/日志
```

## 核心约定

- **接口统一返回** `{ code, data, message }`，`code = 0` 表示成功。
- **项目隔离**：前端通过请求头 `x-project-id` 传递当前项目，后端所有业务数据强制按 `projectId` 过滤。
- **字典驱动**：所有下拉/单选/复选与标签颜色来自 `dict_type` / `dict_item`，后端字典服务带内存缓存，变更后自动刷新。
- **供应商信息不冗余**：合同仅存 `supplierId`，法人/授权人/联系人/银行等信息由供应商库实时关联。

## 常见问题

- **Prisma 引擎下载慢/失败**：`npx prisma generate` 需要从网络下载查询引擎，若失败可配置镜像
  `PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma` 后重试。
- **npm install 卡住**：可改用 `pnpm install`（依赖解析更快，磁盘占用更小）。
- **上传目录**：默认 `server/uploads`，由 `/api/files/**` 静态映射，生产环境建议替换为对象存储
  （`FileController` 是唯一的写入点，替换实现即可）。
- **MySQL 差异**：本模型使用 `Decimal(18,2)` 与 `String` 字典编码，MySQL 下同样适用；
  差异在于 Postgres 支持 `@@unique` 中 nullable 列的多空值（MySQL 允许多个 NULL，语义一致），
  若切换到 MySQL 需把 `@db.Text` 长文本字段改为 `@db.Text`（MySQL 支持）或 `String` 并指定长度。

更多说明见 `docs/` 目录。
