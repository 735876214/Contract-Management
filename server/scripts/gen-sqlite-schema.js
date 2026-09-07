/**
 * 为快速本地演示生成 SQLite 兼容的 Prisma schema。
 * 原 schema.prisma 保持 PostgreSQL 面向正式部署；本脚本派生 schema.sqlite.prisma 用于：
 * 1) 替换 provider = "sqlite"
 * 2) 移除 @db.Decimal(...) 与 @db.Text（SQLite 不支持这些原生属性）
 * 用法：node scripts/gen-sqlite-schema.js
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const dst = path.join(__dirname, '..', 'prisma', 'schema.sqlite.prisma');

let text = fs.readFileSync(src, 'utf8');
text = text.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"');
text = text.replace(/@db\.Decimal\([^)]*\)/g, '');
text = text.replace(/@db\.Text/g, '');
text = text.replace(/url\s*=\s*env\("DATABASE_URL"\)/, 'url      = env("DATABASE_URL")');
fs.writeFileSync(dst, text);
console.log('✓ 生成 SQLite 兼容 schema: prisma/schema.sqlite.prisma');
