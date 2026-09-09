/**
 * 一次性脚本：把「物资采购执行合同模板（步道砖、盲道砖采购合同）」写入当前数据库。
 * 用法：npx ts-node prisma/templates/upsert-purchase-exec.ts
 * 已存在同名模板时跳过（幂等）。
 */
import { PrismaClient } from '@prisma/client';
import { PURCHASE_EXEC_TEMPLATE } from './purchase-exec-contract';

const prisma = new PrismaClient();

async function main() {
  const { variables, ...tpl } = PURCHASE_EXEC_TEMPLATE;
  const exist = await prisma.contractTemplate.findFirst({ where: { name: tpl.name } });
  if (exist) {
    console.log('模板已存在，跳过：', exist.id, exist.name);
    return;
  }
  const admin = await prisma.user.findFirst({ where: { username: 'admin' } });
  const created = await prisma.contractTemplate.create({
    data: {
      ...tpl,
      version: 1,
      createdBy: admin?.id,
      variables: { create: variables.map((v) => ({ ...v })) },
    },
    include: { variables: true },
  });
  console.log('已创建模板：', created.id, created.name, '| 变量数：', created.variables.length);
}

main()
  .catch((e) => {
    console.error('失败：', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
