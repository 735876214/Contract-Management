import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Descriptions,
  DatePicker,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { ExportOutlined, FileWordOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import { contractApi, supplierApi } from '@/api/business';
import DictTag from '@/components/DictSelect';
import { withToken } from '../utils/download';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/**
 * 合同查询（需求 2.2）
 * - 展示已发布/正式合同（起草发布后自动流转至此，status=COMPLETED 或历史正式数据）
 * - 筛选：合同编号/名称关键词、供应商、签订日期范围
 * - 操作：查看详情、导出 Word（按创建时选择的合同模板生成正文，
 *   包含「物料编码清单」「合同清单」两张子表，文件名 {编号}_{名称}.docx）
 */
export default function ContractQuery() {
  const [form] = Form.useForm();
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(false);
  const [suppliers, setSuppliers] = useState<any[]>([]);

  // 详情抽屉
  const [detail, setDetail] = useState<any>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const v = form.getFieldsValue();
      const params: any = { page, pageSize, keyword: v.keyword || undefined, supplierId: v.supplierId || undefined };
      const range = v.signRange as [Dayjs | undefined, Dayjs | undefined] | undefined;
      if (range?.[0]) params.signDateStart = range[0].format('YYYY-MM-DD');
      if (range?.[1]) params.signDateEnd = range[1].format('YYYY-MM-DD');
      const res: any = await contractApi.published(params);
      const list = Array.isArray(res) ? res : res?.list || [];
      setRows(list);
      setTotal(Array.isArray(res) ? list.length : res?.total ?? list.length);
    } finally {
      setLoading(false);
    }
  }, [form, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    supplierApi.options().then((res: any) => setSuppliers(res || []));
  }, []);

  const handleSearch = () => {
    setPage(1);
    load();
  };

  const openDetail = async (id: string) => {
    const d: any = await contractApi.detail(id);
    setDetail(d);
    setDetailOpen(true);
  };

  const handleExport = (row: any) => {
    if (!row.templateId) {
      message.warning('该合同未关联合同模板，无法导出');
      return;
    }
    window.open(withToken(contractApi.exportWordUrl(row.id)));
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="合同查询"
        extra={
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        }
      >
        <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 8 }}>
          <Form.Item name="keyword">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="合同编号 / 名称"
              style={{ width: 220 }}
              onPressEnter={handleSearch}
            />
          </Form.Item>
          <Form.Item name="supplierId">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="供应商"
              style={{ width: 200 }}
              options={suppliers.map((s: any) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item name="signRange">
            <DatePicker.RangePicker placeholder={['签订日期起', '签订日期止']} style={{ width: 240 }} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>
              查询
            </Button>
          </Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          scroll={{ x: 1200 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t: number) => `共 ${t} 条`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
          columns={[
            { title: '合同编号', dataIndex: 'code', width: 200 },
            { title: '合同名称', dataIndex: 'name', width: 220, ellipsis: true },
            {
              title: '供应商',
              dataIndex: ['supplier', 'name'],
              width: 180,
              ellipsis: true,
              render: (v) => v || '-',
            },
            {
              title: '类型',
              dataIndex: 'typeCode',
              width: 120,
              render: (v) => (v ? <DictTag typeCode="contract_type" value={v} /> : '-'),
            },
            {
              title: '签订日期',
              dataIndex: 'signDate',
              width: 120,
              render: (v) => (v ? String(v).slice(0, 10) : '-'),
            },
            { title: '金额', dataIndex: 'amount', width: 140, align: 'right', render: money },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (v) => (v === 'COMPLETED' ? <Tag color="green">已发布</Tag> : <Tag color="blue">正式</Tag>),
            },
            {
              title: '操作',
              key: 'action',
              width: 200,
              fixed: 'right',
              render: (_, row) => (
                <Space size={4}>
                  <Button type="link" size="small" icon={<FileWordOutlined />} onClick={() => handleExport(row)}>
                    导出Word
                  </Button>
                  <Button type="link" size="small" onClick={() => openDetail(row.id)}>
                    详情
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={
          <Space>
            <span>合同详情</span>
            {detail?.code && <Tag color="geekblue">{detail.code}</Tag>}
          </Space>
        }
        placement="right"
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        extra={
          detail && (
            <Button icon={<ExportOutlined />} size="small" onClick={() => handleExport(detail)}>
              导出Word
            </Button>
          )
        }
      >
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="合同编号">{detail.code}</Descriptions.Item>
            <Descriptions.Item label="合同名称">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="供应商">{detail.supplier?.name || '-'}</Descriptions.Item>
            <Descriptions.Item label="合同类型">
              {detail.typeCode ? <DictTag typeCode="contract_type" value={detail.typeCode} /> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="签订日期">
              {detail.signDate ? String(detail.signDate).slice(0, 10) : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="合同金额">{money(detail.amount)}</Descriptions.Item>
            <Descriptions.Item label="执行状态">
              {detail.execStatus ? <DictTag typeCode="contract_execution_status" value={detail.execStatus} /> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="关联合同模板">{detail.templateId || '未关联'}</Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {detail.createdAt ? String(detail.createdAt).slice(0, 19).replace('T', ' ') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="备注">{detail.remark || '-'}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>
    </Space>
  );
}
