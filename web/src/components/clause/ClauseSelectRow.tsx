import { sanitizeHtml } from '@/utils/sanitizeHtml';

import { useEffect, useState } from 'react';
import { Col, Empty, Form, Row, Select, Space, Spin, Tag, Button } from 'antd';
import { Link } from 'react-router-dom';
import { templateApi } from '@/api/business';
import { CLAUSE_TYPE_OPTIONS, type ClauseType } from '@/constants/clauseTypes';

/**
 * 「选择条款」的四个下拉（采购发起第三步 / 合同起草**共用**）。
 *
 * 业务口径（2026-10-16）：条款**只在**「基础信息管理 → 合同条款」新增与维护，
 * 这里**只做选择**，不再就地富文本录入。四个槽位与条款库的四种类型一一对应：
 * 技术条款 + 质量条款 → `technicalClauseId` / `qualityClauseId`
 * （后端保存时把正文**快照**进 techQuality 文本列，下游采前会/公告/文件/成交报告零改动）；
 * 付款条件 → `paymentClauseId`；验收方式 → `acceptanceClauseId`。
 *
 * 四个都**非必填**：新项目条款库可能为空，设成必填会把流程直接卡死。
 * 选中后就地展开条款正文预览（HTML 直渲 —— 条款正文就是富文本 HTML）。
 */
const SLOTS: { name: string; type: ClauseType; label: string; hint?: string }[] = [
  { name: 'technicalClauseId', type: 'technical', label: '技术条款' },
  { name: 'qualityClauseId', type: 'quality', label: '质量条款' },
  { name: 'paymentClauseId', type: 'payment', label: '付款条件' },
  { name: 'acceptanceClauseId', type: 'acceptance', label: '验收方式' },
];

export default function ClauseSelectRow({ form, onAfterChange }: { form: any; onAfterChange?: () => void }) {
  const [clauses, setClauses] = useState<any[] | null>(null);

  useEffect(() => {
    templateApi
      .clauses()
      .then((res: any) => setClauses(res?.list || res || []))
      .catch(() => setClauses([]));
  }, []);

  const previewId = Form.useWatch('technicalClauseId', form);

  if (clauses === null) return <Spin />;
  if (clauses.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span className="cms-hint">
            条款库为空：请先到{' '}
            <Link to="/base/clause">
              <Button type="link" size="small" style={{ padding: 0 }}>
                基础信息管理 → 合同条款
              </Button>
            </Link>{' '}
            添加条款，再回到这里选择。
          </span>
        }
      />
    );
  }

  const previewClause = clauses.find((c) => c.id === previewId);

  return (
    <>
      <Row gutter={16}>
        {SLOTS.map((slot) => (
          <Col xs={24} md={12} key={slot.name}>
            <Form.Item
              name={slot.name}
              label={slot.label}
              tooltip={`从条款库的「${slot.label}」中选择；保存后正文随任务固化（快照）`}
            >
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder={`选择${slot.label}（可留空）`}
                onChange={() => onAfterChange?.()}
                options={clauses
                  .filter((c) => c.type === slot.type)
                  .map((c) => ({ value: c.id, label: c.title }))}
                notFoundContent={`条款库暂无「${slot.label}」类型的条款`}
              />
            </Form.Item>
          </Col>
        ))}
      </Row>
      {previewClause && (
        <div className="page-card" style={{ padding: 12, marginBottom: 8 }}>
          <Space size={8} style={{ marginBottom: 4 }}>
            <Tag color="geekblue">条款预览</Tag>
            <span style={{ fontWeight: 600 }}>{previewClause.title}</span>
            {previewClause.type && <Tag>{CLAUSE_TYPE_OPTIONS.find((o) => o.value === previewClause.type)?.label}</Tag>}
          </Space>
          {/* 条款正文是富文本 HTML，与导出/预览所见即所得 */}
          <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(previewClause.content) }} />
        </div>
      )}
    </>
  );
}
