/**
 * 把「物资采购执行合同模板（步道砖、盲道砖采购合同）」写入当前数据库。
 * 用法：npx ts-node prisma/templates/upsert-purchase-exec.ts
 *
 * **幂等且会刷新内容**：同名模板已存在时**更新 content 与变量表**（按 varKey 补齐/更新默认值），
 * 不再"已存在就跳过"——旧行为会让改了种子源码后重跑脚本无效，库里永远留着陈旧内容。
 */
import { PrismaClient } from '@prisma/client';
import { PURCHASE_EXEC_TEMPLATE } from './purchase-exec-contract';

const prisma = new PrismaClient();

async function main() {
  const { variables, ...tpl } = PURCHASE_EXEC_TEMPLATE;
  const exist = await prisma.contractTemplate.findFirst({ where: { name: tpl.name } });
  const admin = await prisma.user.findFirst({ where: { username: 'admin' } });

  if (!exist) {
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
    return;
  }

  await prisma.contractTemplate.update({
    where: { id: exist.id },
    data: { content: tpl.content, tags: tpl.tags, categoryCode: tpl.categoryCode },
  });
  const existingVars = await prisma.templateVariable.findMany({ where: { templateId: exist.id } });
  const byKey = new Map(existingVars.map((v) => [v.varKey, v]));
  let added = 0;
  let updated = 0;
  for (const v of variables) {
    const old = byKey.get(v.varKey);
    if (!old) {
      await prisma.templateVariable.create({ data: { ...v, templateId: exist.id } });
      added += 1;
    } else {
      await prisma.templateVariable.update({ where: { id: old.id }, data: { ...v } });
      updated += 1;
    }
  }
  const total = await prisma.templateVariable.count({ where: { templateId: exist.id } });
  console.log(`已更新模板：${exist.id} ${exist.name} | 变量 新增 ${added} / 更新 ${updated} / 共 ${total}`);
}

main()
  .catch((e) => {
    console.error('失败：', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
