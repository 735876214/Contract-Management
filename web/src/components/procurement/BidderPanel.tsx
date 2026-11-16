import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Upload,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import DictSelect, { DictTag } from '@/components/DictSelect';
import { fileApi } from '@/api/auth';
import { procurementTaskApi } from '@/api/modules';
import { withToken } from '@/utils/download';
import { fmtAmount } from '@/utils/procurementResultReport';

/**
 * 招标域结构化面板（成交报告页内）——投标/响应单位 + 评标记录。
 *
 * 数据来源与分工（见 CLAUDE.md §4「招标域」）：
 * - **单位与两轮报价来自导入表**（服务端在导入「响应单位情况汇总表」时双写），本面板不改这些列；
 * - 本面板只维护用户手工填的四项：**状态 / 投标文件 / 最终确认价 / 备注**；
 * - **定标由「第二轮报价情况表」的勾选驱动**（服务端把勾中的单位置为「中标」并写入最终确认价），
 *   生成合同的单位与金额即取自这些行；本面板里手改状态会与之相互覆盖，保存前会有提示。
 */
export interface BidderRow {
  id: string;
  bidderName: string;
  seq?: number | null;
  passedFirst?: string;
  firstPreTaxTotal?: number | null;
  secondPreTaxTotal?: number | null;
  finalPreTaxTotal?: number | null;
  status: string;
  bidFileUrl?: string;
  remark?: string;
}

export interface EvaluationRow {
  bidderId: string;
  evaluator: string;
  score?: number | null;
  rank?: number | null;
  conclusion?: string;
  comment?: string;
  evaluatedAt?: string | null;
}

interface Props {
  taskId: string;
  editable: boolean;
}

export default function BidderPanel({ taskId, editable }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bidders, setBidders] = useState<BidderRow[]>([]);
  const [evaluations, setEvaluations] = useState<EvaluationRow[]>([]);

  const load = useCallback(() => {
    if (!taskId) return;
    setLoading(true);
    procurementTaskApi
      .bidders(taskId)
      .then((res: any) => {
        setBidders(Array.isArray(res?.bidders) ? res.bidders : []);
        setEvaluations(
          (Array.isArray(res?.evaluations) ? res.evaluations : []).map((e: any) => ({
            bidderId: e.bidderId,
            evaluator: e.evaluator ?? '',
            score: e.score ?? null,
            rank: e.rank ?? null,
            conclusion: e.conclusion ?? '',
            comment: e.comment ?? '',
            evaluatedAt: e.evaluatedAt ?? null,
          })),
        );
      })
      .catch(() => {
        setBidders([]);
        setEvaluations([]);
      })
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => load(), [load]);

  const patchBidder = (id: string, patch: Partial<BidderRow>) =>
    setBidders((list) => list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const patchEval = (index: number, patch: Partial<EvaluationRow>) =>
    setEvaluations((list) => list.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const bidderName = useMemo(() => {
    const map = new Map<string, string>();
    bidders.forEach((b) => map.set(b.id, b.bidderName));
    return map;
  }, [bidders]);

  const wonCount = bidders.filter((b) => b.status === 'WON').length;

  const handleSave = async () => {
    if (!taskId) return;
    if (evaluations.some((e) => !e.bidderId || !String(e.evaluator || '').trim())) {
      message.warning('评标记录必须选择响应单位并填写评委');
      return;
    }
    setSaving(true);
    try {
      const res: any = await procurementTaskApi.saveBidders(
        taskId,
        bidders.map((b) => ({
          id: b.id,
          status: b.status,
          bidFileUrl: b.bidFileUrl || '',
          finalPreTaxTotal: b.finalPreTaxTotal ?? null,
          remark: b.remark || '',
        })),
      );
      await procurementTaskApi.saveEvaluations(
        taskId,
        evaluations.map((e) => ({
          bidderId: e.bidderId,
          evaluator: e.evaluator,
          score: e.score ?? null,
          rank: e.rank ?? null,
          conclusion: e.conclusion || null,
          comment: e.comment || '',
          evaluatedAt: e.evaluatedAt || null,
        })),
      );
      if (Array.isArray(res?.bidders)) setBidders(res.bidders);
      message.success('投标单位与评标记录已保存');
      load();
    } finally {
      setSaving(false);
    }
  };

  const bidderColumns: ColumnsType<BidderRow> = [
    { title: '序号', dataIndex: 'seq', width: 60, render: (_v, _r, i) => i + 1 },
    { title: '响应单位', dataIndex: 'bidderName', width: 200, fixed: 'left' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (v: string, r) =>
        editable ? (
          <DictSelect typeCode="bidder_status" value={v} onChange={(next) => patchBidder(r.id, { status: next })} />
        ) : (
          <DictTag typeCode="bidder_status" value={v} />
        ),
    },
    {
      title: '第一轮报价（不含税）',
      dataIndex: 'firstPreTaxTotal',
      width: 150,
      align: 'right',
      render: (v: number | null) => fmtAmount(v),
    },
    {
      title: '第二轮报价（不含税）',
      dataIndex: 'secondPreTaxTotal',
      width: 150,
      align: 'right',
      render: (v: number | null) => fmtAmount(v),
    },
    {
      title: '最终确认价（不含税）',
      dataIndex: 'finalPreTaxTotal',
      width: 170,
      render: (v: number | null, r) =>
        editable ? (
          <InputNumber
            style={{ width: 150 }}
            min={0}
            value={v ?? undefined}
            onChange={(next) => patchBidder(r.id, { finalPreTaxTotal: next == null ? null : Number(next) })}
          />
        ) : (
          fmtAmount(v)
        ),
    },
    {
      title: '投标文件',
      dataIndex: 'bidFileUrl',
      width: 180,
      render: (v: string, r) =>
        editable ? (
          <Space size={4}>
            <Upload
              showUploadList={false}
              customRequest={async ({ file, onSuccess, onError }: any) => {
                try {
                  const files = await fileApi.upload([file]);
                  patchBidder(r.id, { bidFileUrl: files?.[0]?.url ?? '' });
                  onSuccess?.(files);
                } catch (e) {
                  onError?.(e as any);
                }
              }}
            >
              <Button size="small" icon={<UploadOutlined />}>
                {v ? '重新上传' : '上传'}
              </Button>
            </Upload>
            {v ? (
              <>
                <a href={withToken(v)} target="_blank" rel="noreferrer">
                  查看
                </a>
                <Button type="link" size="small" onClick={() => patchBidder(r.id, { bidFileUrl: '' })}>
                  清除
                </Button>
              </>
            ) : null}
          </Space>
        ) : v ? (
          <a href={withToken(v)} target="_blank" rel="noreferrer">
            查看
          </a>
        ) : (
          '-'
        ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 200,
      render: (v: string, r) =>
        editable ? (
          <Input value={v} onChange={(e) => patchBidder(r.id, { remark: e.target.value })} />
        ) : (
          v || '-'
        ),
    },
  ];

  const evalColumns: ColumnsType<EvaluationRow> = [
    {
      title: '响应单位',
      dataIndex: 'bidderId',
      width: 200,
      render: (v: string, _r, i) =>
        editable ? (
          <Select
            style={{ minWidth: 180 }}
            value={v || undefined}
            showSearch
            optionFilterProp="label"
            placeholder="请选择"
            options={bidders.map((b) => ({ value: b.id, label: b.bidderName }))}
            onChange={(next) => patchEval(i, { bidderId: next })}
          />
        ) : (
          bidderName.get(v) || '-'
        ),
    },
    {
      title: '评委',
      dataIndex: 'evaluator',
      width: 160,
      render: (v: string, _r, i) =>
        editable ? <Input value={v} onChange={(e) => patchEval(i, { evaluator: e.target.value })} /> : v || '-',
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 120,
      render: (v: number | null, _r, i) =>
        editable ? (
          <InputNumber
            style={{ width: 100 }}
            min={0}
            value={v ?? undefined}
            onChange={(next) => patchEval(i, { score: next == null ? null : Number(next) })}
          />
        ) : (
          (v ?? '-')
        ),
    },
    {
      title: '排名',
      dataIndex: 'rank',
      width: 100,
      render: (v: number | null, _r, i) =>
        editable ? (
          <InputNumber
            style={{ width: 80 }}
            min={1}
            precision={0}
            value={v ?? undefined}
            onChange={(next) => patchEval(i, { rank: next == null ? null : Number(next) })}
          />
        ) : (
          (v ?? '-')
        ),
    },
    {
      title: '结论',
      dataIndex: 'conclusion',
      width: 140,
      render: (v: string, _r, i) =>
        editable ? (
          <DictSelect
            typeCode="evaluation_conclusion"
            value={v}
            onChange={(next) => patchEval(i, { conclusion: next })}
          />
        ) : (
          <DictTag typeCode="evaluation_conclusion" value={v} />
        ),
    },
    {
      title: '评标时间',
      dataIndex: 'evaluatedAt',
      width: 140,
      render: (v: string | null, _r, i) =>
        editable ? (
          <DatePicker
            style={{ width: 140 }}
            value={v ? dayjs(v) : null}
            onChange={(d) => patchEval(i, { evaluatedAt: d ? d.format('YYYY-MM-DD') : null })}
          />
        ) : v ? (
          dayjs(v).format('YYYY-MM-DD')
        ) : (
          '-'
        ),
    },
    {
      title: '备注',
      dataIndex: 'comment',
      width: 150,
      render: (v: string, _r, i) =>
        editable ? <Input value={v} onChange={(e) => patchEval(i, { comment: e.target.value })} /> : v || '-',
    },
    {
      title: '操作',
      key: 'op',
      width: 80,
      fixed: 'right',
      render: (_v, _r, i) =>
        editable ? (
          <Popconfirm title="删除这条评标记录？" onConfirm={() => setEvaluations((l) => l.filter((_, k) => k !== i))}>
            <Button type="link" danger size="small" icon={<DeleteOutlined />} />
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card
        size="small"
        title="六、投标单位（结构化）"
        extra={
          <span style={{ color: 'var(--cms-muted-soft)', fontSize: 12 }}>
            {wonCount > 0 ? `当前中标 ${wonCount} 家 → 将生成 ${wonCount} 份合同` : '尚未勾选成交候选人'}
          </span>
        }
      >
        <Table
          size="small"
          rowKey="id"
          loading={loading}
          columns={bidderColumns}
          dataSource={bidders}
          pagination={false}
          scroll={{ x: 1200 }}
          locale={{ emptyText: '暂无数据，请先导入「响应单位情况汇总表」' }}
        />
        <div style={{ color: 'var(--cms-muted-soft)', fontSize: 12, marginTop: 8 }}>
          单位与两轮报价来自导入表；此处维护「状态 / 投标文件 / 最终确认价 / 备注」。
          勾选「拟推荐成交候选人」会把对应单位置为「中标」并写入最终确认价，生成合同的单位与金额取自中标行。
        </div>
      </Card>

      <Card
        size="small"
        title="七、评标记录"
        extra={
          editable ? (
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() =>
                setEvaluations((l) => [
                  ...l,
                  { bidderId: '', evaluator: '', score: null, rank: null, conclusion: '', comment: '', evaluatedAt: null },
                ])
              }
            >
              添加
            </Button>
          ) : null
        }
      >
        <Table
          size="small"
          rowKey={(_r, i) => String(i)}
          columns={evalColumns}
          dataSource={evaluations}
          pagination={false}
          scroll={{ x: 1000 }}
          locale={{ emptyText: '暂无评标记录' }}
        />
      </Card>

      {editable ? (
        <Space>
          <Button type="primary" loading={saving} onClick={handleSave}>
            保存投标单位与评标记录
          </Button>
          <span style={{ color: 'var(--cms-muted-soft)', fontSize: 12 }}>
            评标记录为全量替换：下方表格里删掉的行，保存后即从库中删除。
          </span>
        </Space>
      ) : null}
    </Space>
  );
}
