import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Upload,
  message,
} from 'antd';
import {
  ExportOutlined,
  FileWordOutlined,
  FileProtectOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
  PlusSquareOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { contractApi, supplierApi } from '@/api/business';
import DictTag from '@/components/DictSelect';
import SupplementDraft from '@/components/contract/SupplementDraft';
import { withToken } from '../utils/download';

const money = (v: number) =>
  v == null ? '-' : `¥${Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/** 状态标签（需求修正6：审批中-蓝 / 已签章-绿；历史空状态与 COMPLETED 数据按审批中展示） */
function StatusTag({ status }: { status?: string | null }) {
  if (status === 'SIGNED') return <Tag color="green">已签章</Tag>;
  if (status === 'DRAFT') return <Tag color="default">草稿中</Tag>;
  return <Tag color="blue">审批中</Tag>;
}

const ACCEPT = '.pdf,.jpg,.jpeg,.png,.docx';
const MAX_SIZE = 20 * 1024 * 1024;

/**
 * 合同查询（需求 2.2 / 需求修正4/5/6）
 * - 展示审批中/已签章的正式合同（起草发布后自动流转至此）
 * - 筛选：合同编号/名称关键词、供应商、签订日期范围
 * - 操作：合同签章（上传签章文件+签订日期，状态自动变为已签章）、查看详情、导出 Word、下载签章合同
 * - 需求 2.1：合同类型只读（后端同步校验，发布后不可修改）
 * - 需求 2.2：导出 Word 仅草稿中不可用，审批中/已签章均可导出
 * - 需求 2.3：签章时选择的签订日期覆盖合同主表签订日期
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

  // 新增补充协议抽屉
  const [suppOpen, setSuppOpen] = useState(false);
  const [suppParent, setSuppParent] = useState<any>(null);

  // 合同签章弹窗
  const [signOpen, setSignOpen] = useState(false);
  const [signTarget, setSignTarget] = useState<any>(null);
  const [signFile, setSignFile] = useState<File | null>(null);
  const [signing, setSigning] = useState(false);
  const [signForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const v = form.getFieldsValue();
      const params: any = { page, pageSize, keyword: v.keyword || undefined, supplierId: v.supplierId || undefined };
      const range = v.signRange as [Dayjs | undefined, Dayjs | undefined] | undefined;
      if (range?.[0]) params.signDateStart = range[0].format('YYYY-MM-DD');
      if (range?.[1]) params.signDateEnd = range[1].format('YYYY-MM-DD');
      const res: any = await contractApi.published(params);
      const data = res?.data ?? res;
      const list = Array.isArray(data) ? data : data?.list || [];
      setRows(list);
      setTotal(Array.isArray(data) ? list.length : data?.total ?? list.length);
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

  /** 需求 2.2：草稿中不可导出 Word，审批中 / 已签章均可导出 */
  const canExportWord = (row: any) => row?.status !== 'DRAFT';

  const handleExport = (row: any) => {
    if (!canExportWord(row)) {
      message.warning('草稿中的合同不可导出，请先发布后再导出 Word 文件');
      return;
    }
    if (!row.templateId) {
      message.warning('该合同未关联合同模板，无法导出');
      return;
    }
    window.open(withToken(contractApi.exportWordUrl(row.id)));
  };

  const openSign = (row: any) => {
    setSignTarget(row);
    setSignFile(null);
    signForm.resetFields();
    // 需求 2.3：签订日期优先取合同主表 signDate，兼容历史签章记录 signedDate
    const prev = row.signDate || row.signedDate;
    signForm.setFieldsValue({
      signDate: prev ? dayjs(prev) : undefined,
      remark: row.signedRemark || '',
    });
    setSignOpen(true);
  };

  const beforeUpload = (file: File) => {
    const ok = /\.(pdf|jpe?g|png|docx)$/i.test(file.name);
    if (!ok) {
      message.error('仅支持 PDF/JPG/PNG/DOCX 格式文件');
      return Upload.LIST_IGNORE;
    }
    if (file.size > MAX_SIZE) {
      message.error('文件大小不能超过 20MB');
      return Upload.LIST_IGNORE;
    }
    setSignFile(file);
    return false; // 手动上传
  };

  const handleSign = async () => {
    if (!signTarget) return;
    const values = await signForm.validateFields();
    if (!signFile && !signTarget.signedFilePath) {
      message.warning('请上传签章合同文件');
      return;
    }
    setSigning(true);
    try {
      const fd = new FormData();
      if (signFile) fd.append('file', signFile);
      fd.append('signDate', values.signDate.format('YYYY-MM-DD'));
      fd.append('remark', values.remark || '');
      await contractApi.sign(signTarget.id, fd);
      message.success('签章信息已保存，签订日期已更新，合同状态：已签章');
      setSignOpen(false);
      setSignTarget(null);
      setSignFile(null);
      load();
    } finally {
      setSigning(false);
    }
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
            <DatePicker.RangePicker format="YYYY-MM-DD" placeholder={['签订日期起', '签订日期止']} style={{ width: 240 }} />
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
          scroll={{ x: 1400 }}
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
            { title: '合同编号', dataIndex: 'code', width: 200, fixed: 'left' },
            { title: '合同名称', dataIndex: 'name', width: 220, ellipsis: true },
            {
              title: '供应商',
              dataIndex: ['supplier', 'name'],
              width: 170,
              ellipsis: true,
              render: (v) => v || '-',
            },
            {
              title: '合同类型',
              dataIndex: 'typeCode',
              width: 120,
              // 需求 2.1：合同类型只读展示（发布后不可修改）
              render: (v) => (v ? <DictTag typeCode="contract_type" value={v} /> : '-'),
            },
            { title: '合同金额', dataIndex: 'amount', width: 140, align: 'right', render: money },
            {
              title: '签订日期',
              dataIndex: 'signDate',
              width: 120,
              // 需求 2.3：优先展示合同主表签订日期，兼容历史签章记录
              render: (v, row: any) => {
                const d = v || row.signedDate;
                return d ? String(d).slice(0, 10) : '-';
              },
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 100,
              render: (v) => <StatusTag status={v} />,
            },
            {
              title: '操作',
              key: 'action',
              width: 330,
              fixed: 'right',
              render: (_, row) => (
                <Space size={2} wrap>
                  <Button type="link" size="small" icon={<FileProtectOutlined />} onClick={() => openSign(row)}>
                    {row.status === 'SIGNED' ? '重新签章' : '合同签章'}
                  </Button>
                  <Button type="link" size="small" icon={<PlusSquareOutlined />} onClick={() => { setSuppParent(row); setSuppOpen(true); }}>
                    新增补充协议
                  </Button>
                  <Button type="link" size="small" onClick={() => openDetail(row.id)}>
                    详情
                  </Button>
                  {canExportWord(row) && (
                    <Button
                      type="link"
                      size="small"
                      icon={<FileWordOutlined />}
                      onClick={() => handleExport(row)}
                    >
                      导出Word
                    </Button>
                  )}
                  {row.signedFilePath && (
                    <Button
                      type="link"
                      size="small"
                      icon={<ExportOutlined />}
                      onClick={() => window.open(withToken(contractApi.signedFileUrl(row.id)))}
                    >
                      下载签章合同
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* ==================== 合同签章弹窗（需求修正4） ==================== */}
      <Modal
        title={
          <Space>
            <FileProtectOutlined />
            <span>合同签章</span>
            {signTarget?.status === 'SIGNED' && <Tag color="green">已签章 · 可重新上传覆盖</Tag>}
          </Space>
        }
        open={signOpen}
        onCancel={() => { setSignOpen(false); setSignTarget(null); setSignFile(null); }}
        onOk={handleSign}
        confirmLoading={signing}
        okText="保存签章信息"
        width={560}
        destroyOnClose
      >
        <Form form={signForm} layout="vertical">
          <Form.Item label="合同编号">
            <Input value={signTarget?.code} disabled />
          </Form.Item>
          <Form.Item label="合同名称">
            <Input value={signTarget?.name} disabled />
          </Form.Item>
          <Form.Item
            name="signDate"
            label="签订日期"
            rules={[{ required: true, message: '请选择签订日期' }]}
            extra="保存后将以本次选择的日期覆盖该合同的签订日期"
          >
            <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder="YYYY-MM-DD" />
          </Form.Item>
          <Form.Item
            label="签章合同文件"
            required={!signTarget?.signedFilePath}
            extra="支持 PDF / JPG / PNG / DOCX，单个文件不超过 20MB；已签章的合同可重新上传覆盖"
          >
            <Upload.Dragger
              accept={ACCEPT}
              maxCount={1}
              beforeUpload={beforeUpload}
              onRemove={() => setSignFile(null)}
              fileList={signFile ? [{ uid: '-1', name: signFile.name, status: 'done' }] as any : []}
            >
              <p className="ant-upload-drag-icon">
                <UploadOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽文件到此处上传</p>
            </Upload.Dragger>
          </Form.Item>
          {(signTarget?.signDate || signTarget?.signedDate) && (
            <Form.Item label="当前签章信息">
              <Space wrap>
                <Tag color="green">
                  签订日期：{String(signTarget.signDate || signTarget.signedDate).slice(0, 10)}
                </Tag>
                {signTarget.signedAt && (
                  <Tag>签章时间：{String(signTarget.signedAt).slice(0, 19).replace('T', ' ')}</Tag>
                )}
                {signTarget.signedFileName && <Tag>{signTarget.signedFileName}</Tag>}
              </Space>
            </Form.Item>
          )}
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} placeholder="选填" />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={
          <Space>
            <span>合同详情</span>
            {detail?.code && <Tag color="geekblue">{detail.code}</Tag>}
            {detail && <StatusTag status={detail.status} />}
          </Space>
        }
        placement="right"
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        extra={
          detail && (
            <Space>
              <Button icon={<FileProtectOutlined />} size="small" onClick={() => { setDetailOpen(false); openSign(detail); }}>
                合同签章
              </Button>
              {detail && canExportWord(detail) && (
                <Button
                  icon={<ExportOutlined />}
                  size="small"
                  onClick={() => handleExport(detail)}
                >
                  导出Word
                </Button>
              )}
            </Space>
          )
        }
      >
        {detail && (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="合同编号">{detail.code}</Descriptions.Item>
            <Descriptions.Item label="合同名称">{detail.name}</Descriptions.Item>
            <Descriptions.Item label="供应商">{detail.supplier?.name || '-'}</Descriptions.Item>
            <Descriptions.Item
              label="合同类型（只读）"
            >
              {detail.typeCode ? <DictTag typeCode="contract_type" value={detail.typeCode} /> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="签订日期">
              {detail.signDate || detail.signedDate
                ? String(detail.signDate || detail.signedDate).slice(0, 10)
                : '未签订'}
            </Descriptions.Item>
            {detail.signedAt && (
              <Descriptions.Item label="签章操作时间">
                {String(detail.signedAt).slice(0, 19).replace('T', ' ')}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="合同金额">{money(detail.amount)}</Descriptions.Item>
            <Descriptions.Item label="执行状态">
              {detail.execStatus ? <DictTag typeCode="contract_execution_status" value={detail.execStatus} /> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="关联合同模板">{detail.templateId || '未关联'}</Descriptions.Item>
            <Descriptions.Item label="签章文件">
              {detail.signedFilePath ? (
                <Button
                  type="link"
                  size="small"
                  icon={<ExportOutlined />}
                  onClick={() => window.open(withToken(contractApi.signedFileUrl(detail.id)))}
                >
                  {detail.signedFileName || '下载签章合同'}
                </Button>
              ) : (
                '未上传'
              )}
            </Descriptions.Item>
            {detail.signedRemark && (
              <Descriptions.Item label="签章备注">{detail.signedRemark}</Descriptions.Item>
            )}
            <Descriptions.Item label="创建时间">
              {detail.createdAt ? String(detail.createdAt).slice(0, 19).replace('T', ' ') : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="备注">{detail.remark || '-'}</Descriptions.Item>
          </Descriptions>
        )}
      </Drawer>

      <SupplementDraft
        parent={suppParent}
        open={suppOpen}
        onClose={() => setSuppOpen(false)}
        onDone={() => { setSuppOpen(false); load(); }}
      />
    </Space>
  );
}
