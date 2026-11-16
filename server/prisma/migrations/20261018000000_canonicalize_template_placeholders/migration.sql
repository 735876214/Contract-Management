-- ============================================================================
-- 合同模板占位符「规范化」：单花括号 `{变量名}` 与英文遗留 key → 规范双花括号 `{{变量名}}`
--
-- 背景：`template.service.generate()` 曾为兼容历史模板同时替换四种写法：
--   ① `{{中文}}`（规范）  ② `{{ENGLISH_KEY}}`（英文遗留）
--   ③ `{中文}`（单花括号遗留）  ④ 变量表中每个 key 的 `{key}` 与 `{{key}}`
-- 2026-10 定稿：模板语法**只保留 ①**（见 server/src/modules/template/template-render.ts 文件头，docs/06 #5）。
-- 移除依据：本项目**无存量业务数据**、无需兼容；且单花括号替换会误伤富文本里的
-- `<style>.x{color:red}</style>` 之类字面量，并对已插入的表格 HTML 做二次替换。
--
-- 本迁移把库里**已有**的模板内容统一到 ①，随后生成器不再认 ②③。
--
-- 语义安全性：四种写法在旧生成器里都被替换为**同一个值**，故改写不改变渲染结果
-- （验收方式：改写前后用同一模板生成正文，逐字节比对相同）。
--
-- 变量名清单来源（**不要手敲**，用脚本从代码抽取后粘贴）：
--   generate() 的 values 键 ∪ parseSupplement() 键 ∪ web/src/pages/Clauses.tsx 的 VARIABLE_GROUPS ∪
--   库中 TemplateVariable.varKey 实测值 → 见本文件 DO 块。名单多列无害（多出的名字在 WHERE 上不会命中）。
-- ============================================================================

-- 1) 英文遗留 key → 中文规范 key（双花括号，无歧义，直接 replace）
UPDATE "ContractTemplate"
   SET content = replace(content, '{{MATERIAL_CODE_TABLE}}', '{{物料编码清单}}')
 WHERE content LIKE '%{{MATERIAL_CODE_TABLE}}%';

UPDATE "ContractTemplate"
   SET content = replace(content, '{{CONTRACT_ITEM_TABLE}}', '{{合同清单}}')
 WHERE content LIKE '%{{CONTRACT_ITEM_TABLE}}%';

-- 2) 单花括号 → 双花括号
--   ⚠️ 必须用 `([^{]|^)` 守卫（PostgreSQL 正则不支持 lookbehind）：否则 `{{合同清单}}` 内层的
--      `{合同清单}` 也会被匹配，替换后变成 `{{{合同清单}}}`（破坏模板）。
--   ⚠️ 守卫会「消费掉」前一个字符，故相邻占位符（如 `{A}{A}`）一轮只能替换前一个 → 每个名字**最多跑 3 轮**。
DO $$
DECLARE
  names text[] := ARRAY[
    '不合格品清运时限', '乙方名称', '争议解决法院', '交货地点', '付款条件', '供应商名称', '公司地址',
    '其他补充协议内容', '原合同名称', '原合同编号', '原合同金额总价大写', '合同名称', '合同子类型',
    '合同工期', '合同授权人姓名', '合同授权人电话', '合同授权人身份证号', '合同清单', '合同类型',
    '合同约定付款方式', '合同编号', '合同额', '合同额大写', '履约保证金', '当前日期', '技术条款',
    '数量汇总', '新增合同金额总价大写', '最终结算支付比例', '法人姓名', '法人电话', '物料编码清单',
    '物资产地', '甲方名称', '甲方地址', '甲方开户行及账号', '甲方统一社会信用代码', '甲方联系电话',
    '税率', '签订地点', '签订日期', '累计补充协议占比', '联系人姓名', '联系人电话', '联系人邮箱',
    '补充协议类型', '补充协议编号', '补充协议表', '质保期年限', '质保金比例', '质量条款',
    '进度款支付比例', '采购订单提前天数', '银行名称', '银行账号', '项目名称', '项目简称', '验收方式'
  ];
  n text;
  pass int;
  hits int;
BEGIN
  FOREACH n IN ARRAY names LOOP
    FOR pass IN 1..3 LOOP
      EXIT WHEN pass > 1 AND hits = 0;
      UPDATE "ContractTemplate"
         SET content = regexp_replace(content, '([^{]|^)\{' || n || '\}', '\1{{' || n || '}}', 'g')
       WHERE content ~ ('(^|[^{])\{' || n || '\}');
      GET DIAGNOSTICS hits = ROW_COUNT;
    END LOOP;
  END LOOP;
END $$;
