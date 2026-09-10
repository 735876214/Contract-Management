import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Drawer, Form, Image, Input, Modal,
  Popconfirm, Row, Select, Space, Table, Tag, Upload, message,
} from 'antd';
import type { UploadFile } from 'antd';
import {
  ArrowLeftOutlined, EyeOutlined, FilePdfOutlined, PlusOutlined,
  ReloadOutlined, SaveOutlined, SearchOutlined, UploadOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { contractApi, subcontractorApi } from '@/api/business';
import { fileApi } from '@/api/auth';
import { useTable } from '@/hooks/useTable';

const STATUS_META: Record<string, { label: string; color: string }> = {
  EDITING: { label: '编辑中', color: 'orange' },
  COMPLETED: { label: '已完成', color: 'green' },
};

/** 后端文件上传后的返回结构 → antd Upload fileList 项 */
const toUploadList = (url?: string | null, name?: string): UploadFile[] =>
  url ? [{ uid: '-1', name: name || '已上传文件', status: 'done', url }] : [];

/** 从 Upload 事件里取后端返回的 url */
const urlOf = (file: any): string =>
  file?.response?.url || file?.url || file?.response?.[0]?.url || '';

const FORM_FIELDS = [
  ['subcontractorName', '分包商名称', true],
  ['legalPerson', '法人姓名', true],
  ['authorizedPerson', '材料授权人姓名', true],
  ['authorizedPersonIdNo', '材料授权人身份证号', true],
  ['projectName', '项目名称', true],
  ['subcontractContent', '分包合同内容', true],
] as const;

/** 授权委托书预览弹窗（iframe 渲染后端返回的打印就绪 HTML） */
function LetterPreviewModal({
  open, html, title, onClose, onExport,
}: {
  open: boolean;
  html: string;
  title: string;
  onClose: () => void;
  onExport: () => void;
}) {
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onClose}
      width={920}
      styles={{ body: { padding: 0 } }}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" icon={<FilePdfOutlined />} onClick={onExport}>
            导出 PDF
          </Button>
        </Space>
      }
    >
      <iframe
        title="授权委托书预览"
        srcDoc={html}
        style={{ width: '100%', height: '68vh', border: 'none', background: '#fff' }}
      />
    </Modal>
  );
}

export default function Subcontractors() {
  const { loading, list, search, reload, pagination } = useTable<any>((p) => subcontractorApi.list(p));
  const [filterForm] = Form.useForm();

  // -------- 编辑态 --------
  const [mode, setMode] = useState<'list' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form] = Form.useForm();
  const [pendingValues, setPendingValues] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);

  // 上传类字段（走独立上传，不进 Form）
  const [idCardFront, setIdCardFront] = useState<string | null>(null);
  const [idCardBack, setIdCardBack] = useState<string | null>(null);
  const [signedAuthFile, setSignedAuthFile] = useState<string | null>(null);
  const [signatureScreenshot, setSignatureScreenshot] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  // 分包合同下拉（互锁数据源）
  const [contracts, setContracts] = useState<any[]>([]);

  // -------- 预览 / 详情 --------
  const [preview, setPreview] = useState<{ open: boolean; html: string; title: string }>({
    open: false, html: '', title: '',
  });
  const [detail, setDetail] = useState<any>(null);
  const previewRef = useRef<{ values: any; id: string | null }>({ values: null, id: null });

  useEffect(() => {
    contractApi.options().then((res: any) => setContracts(res || [])).catch(() => undefined);
  }, []);

  // -------- 上传 --------
  const upload = useCallback(async (file: File, setter: (url: string) => void, key: string) => {
    setUploading(key);
    try {
      const files = await fileApi.upload([file]);
      const url = files?.[0]?.url;
      if (!url) throw new Error('上传失败');
      setter(url);
      message.success('上传成功');
    } catch {
      /* 错误已由拦截器提示 */
    } finally {
      setUploading(null);
    }
  }, []);

  // -------- 新增 / 编辑 --------
  const resetUploads = () => {
    setIdCardFront(null);
    setIdCardBack(null);
    setSignedAuthFile(null);
    setSignatureScreenshot(null);
  };

  const startCreate = () => {
    setEditingId(null);
    resetUploads();
    setPendingValues({ subcontractorName: '', projectName: '' });
    setMode('edit');
  };

  const startEdit = async (row: any) => {
    setEditingId(row.id);
    try {
      const d: any = await subcontractorApi.detail(row.id);
      setIdCardFront(d.idCardFront || null);
      setIdCardBack(d.idCardBack || null);
      setSignedAuthFile(d.signedAuthFile || null);
      setSignatureScreenshot(d.signatureScreenshot || null);
      setPendingValues(d);
      setMode('edit');
    } catch {
      /* 错误已由拦截器提示 */
    }
  };

  // 编辑视图挂载后再赋值（<Form> 连接后），避免赋值丢失
  useEffect(() => {
    if (mode === 'edit' && pendingValues) {
      form.resetFields();
      form.setFieldsValue({ ...pendingValues, subcontractId: pendingValues.subcontractId || undefined });
      setPendingValues(null);
    }
  }, [mode, pendingValues, form]);

  const currentValues = () => ({ ...form.getFieldsValue() });

  // -------- 预览 --------
  const openPreview = async (id: string | null) => {
    const values = currentValues();
    if (!values.subcontractorName) return message.warning('请先填写分包商名称');
    const html = id
      ? await subcontractorApi.letterHtml(id)
      : await subcontractorApi.previewHtml(values);
    previewRef.current = { values, id };
    setPreview({ open: true, html, title: `授权委托书预览 - ${values.subcontractorName}` });
  };

  /** 导出 PDF：打开新窗口 → 浏览器打印另存；同时落库为「编辑中」 */
  const doExportPdf = async () => {
    const { values } = previewRef.current;
    if (!values?.subcontractorName) return message.warning('请先填写分包商名称');
    // 1) 落库（新增或更新），状态置为编辑中
    let savedId = editingId;
    try {
      const saved: any = await subcontractorApi.exportMark({
        ...values,
        id: editingId || undefined, // 编辑态按 id 更新，避免重复新增
        idCardFront,
        idCardBack,
        signatureScreenshot,
        signedAuthFile,
      });
      savedId = saved?.id || editingId;
      if (!editingId && savedId) setEditingId(savedId);
    } catch {
      return; // 拦截器已提示
    }
    // 2) 打开打印窗口（用户可在打印对话框中选择「另存为 PDF」）
    const html = savedId ? await subcontractorApi.letterHtml(savedId) : preview.html;
    const w = window.open('', '_blank');
    if (!w) return message.warning('浏览器阻止了新窗口，请允许弹窗后重试');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
    message.success(
      `已生成委托书：分包材料员授权委托书_${values.subcontractorName}_${dayjs().format('YYYYMMDD')}.pdf（状态：编辑中）`,
    );
    setPreview({ open: false, html: '', title: '' });
    reload();
  };

  /** 上传签字盖章版 + 签字截图 → 已完成 */
  const completeFlow = async () => {
    if (!editingId) return message.warning('请先导出 PDF 并保存到分包商库');
    if (!signedAuthFile) return message.warning('请上传签字盖章版委托书');
    if (!signatureScreenshot) return message.warning('请上传委托书签字部分截图');
    await subcontractorApi.complete(editingId, { signedAuthFile, signatureScreenshot });
    message.success('已完成，分包商信息已同步至分包商库');
    setMode('list');
    resetUploads();
    reload();
  };

  const saveOnly = async () => {
    const values = await form.validateFields();
    const payload = { ...values, idCardFront, idCardBack, signatureScreenshot, signedAuthFile };
    setSaving(true);
    try {
      if (editingId) await subcontractorApi.update(editingId, payload);
      else {
        const saved: any = await subcontractorApi.create(payload);
        setEditingId(saved?.id || null);
      }
      message.success('保存成功');
      reload();
    } finally {
      setSaving(false);
    }
  };

  const total = useMemo(() => list.length, [list]);

  // ==================== 列表视图 ====================
  if (mode === 'list') {
    return (
      <Card
        title="分包商库"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={reload}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={startCreate}>新增授权委托书</Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="分包商信息通过「分包材料员授权委托书」同步"
          description="流程：新增 → 填写信息 → 导出 PDF（状态：编辑中）→ 线下签字盖章 → 上传签字盖章版委托书 + 签字截图 → 状态：已完成。"
        />

        <Form form={filterForm} layout="inline" style={{ marginBottom: 12, rowGap: 8 }} onFinish={(v) => search(v)}>
          <Form.Item name="keyword">
            <Input
              allowClear
              placeholder="分包商名称 / 法人 / 材料授权人"
              prefix={<SearchOutlined />}
              style={{ width: 260 }}
            />
          </Form.Item>
          <Form.Item name="status">
            <Select
              allowClear
              placeholder="状态"
              style={{ width: 140 }}
              options={Object.entries(STATUS_META).map(([value, m]) => ({ value, label: m.label }))}
            />
          </Form.Item>
          <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={list}
          pagination={pagination}
          scroll={{ x: 1500 }}
          locale={{ emptyText: '暂无数据...' }}
          columns={[
            { title: '序号', width: 70, fixed: 'left', render: (_: any, __: any, i: number) => (pagination.current - 1) * pagination.pageSize + i + 1 },
            { title: '分包商名称', dataIndex: 'subcontractorName', width: 220, fixed: 'left', ellipsis: true, render: (v: any) => v || '-' },
            { title: '分包合同内容', dataIndex: 'subcontractContent', width: 200, ellipsis: true, render: (v: any) => v || '-' },
            { title: '法人姓名', dataIndex: 'legalPerson', width: 110, render: (v: any) => v || '-' },
            { title: '材料授权人姓名', dataIndex: 'authorizedPerson', width: 140, render: (v: any) => v || '-' },
            { title: '授权人身份证号', dataIndex: 'authorizedPersonIdNo', width: 190, ellipsis: true, render: (v: any) => v || '-' },
            { title: '项目名称', dataIndex: 'projectName', width: 190, ellipsis: true, render: (v: any) => v || '-' },
            {
              title: '状态', dataIndex: 'status', width: 100, align: 'center' as const,
              render: (v: any) => {
                const m = STATUS_META[v] || { label: v || '-', color: 'default' };
                return <Tag color={m.color}>{m.label}</Tag>;
              },
            },
            { title: '创建时间', dataIndex: 'createdAt', width: 160, render: (v: any) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-') },
            {
              title: '操作', width: 200, fixed: 'right',
              render: (_: any, row: any) => (
                <Space size={2}>
                  <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setDetail(row)}>详情</Button>
                  <Button type="link" size="small" onClick={() => startEdit(row)}>编辑</Button>
                  <Popconfirm
                    title="删除后不可恢复，确认删除该分包商？"
                    onConfirm={async () => { await subcontractorApi.remove(row.id); message.success('已删除'); reload(); }}
                  >
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <div style={{ marginTop: 8, color: '#888' }}>共 {total} 条分包商记录</div>

        <Drawer title="分包商详情" width={620} open={!!detail} onClose={() => setDetail(null)}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="分包商名称">{detail?.subcontractorName || '-'}</Descriptions.Item>
            <Descriptions.Item label="分包合同内容">{detail?.subcontractContent || '-'}</Descriptions.Item>
            <Descriptions.Item label="法人姓名">{detail?.legalPerson || '-'}</Descriptions.Item>
            <Descriptions.Item label="材料授权人姓名">{detail?.authorizedPerson || '-'}</Descriptions.Item>
            <Descriptions.Item label="授权人身份证号">{detail?.authorizedPersonIdNo || '-'}</Descriptions.Item>
            <Descriptions.Item label="项目名称">{detail?.projectName || '-'}</Descriptions.Item>
            <Descriptions.Item label="状态">
              {detail?.status ? <Tag color={STATUS_META[detail.status]?.color}>{STATUS_META[detail.status]?.label}</Tag> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="备注">{detail?.remark || '-'}</Descriptions.Item>
            <Descriptions.Item label="身份证正面">
              {detail?.idCardFront ? <Image src={detail.idCardFront} width={140} /> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="身份证反面">
              {detail?.idCardBack ? <Image src={detail.idCardBack} width={140} /> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="签字盖章版委托书">
              {detail?.signedAuthFile ? <a href={detail.signedAuthFile} target="_blank" rel="noreferrer">查看文件</a> : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="签字部分截图">
              {detail?.signatureScreenshot ? <Image src={detail.signatureScreenshot} width={160} /> : '-'}
            </Descriptions.Item>
          </Descriptions>
        </Drawer>
      </Card>
    );
  }

  // ==================== 编辑视图 ====================
  return (
    <Card
      title={
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => { setMode('list'); setEditingId(null); }}>返回列表</Button>
          <span>{editingId ? '编辑授权委托书' : '新增分包材料员授权委托书'}</span>
        </Space>
      }
      extra={
        <Space>
          <Button icon={<SaveOutlined />} loading={saving} onClick={saveOnly}>保存</Button>
          <Button type="primary" icon={<FilePdfOutlined />} onClick={() => openPreview(editingId)}>
            预览并导出 PDF
          </Button>
          <Button onClick={completeFlow}>上传盖章件并完成</Button>
        </Space>
      }
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="操作流程"
        description="① 填写以下信息 ② 点击「预览并导出 PDF」生成委托书（表格编号 CCCEC-SW-B40410）③ 线下签字盖章 ④ 上传签字盖章版委托书与签字截图 ⑤ 点击「上传盖章件并完成」，状态流转为「已完成」。"
      />

      <Card size="small" title="分包材料员授权委托书信息" style={{ marginBottom: 12 }}>
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            {FORM_FIELDS.map(([name, label, required]) => (
              <Col xs={24} md={12} key={name}>
                <Form.Item
                  name={name}
                  label={label}
                  rules={required ? [{ required: true, message: `请填写${label}` }] : undefined}
                >
                  <Input maxLength={200} allowClear placeholder={`请输入${label}`} />
                </Form.Item>
              </Col>
            ))}
            <Col xs={24} md={12}>
              <Form.Item name="subcontractId" label="分包合同（关联合同）">
                <Select
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  placeholder="请选择分包合同"
                  options={contracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="remark" label="备注">
                <Input maxLength={200} allowClear placeholder="选填" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Card>

      <Card size="small" title="附件上传">
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <div style={{ marginBottom: 6 }}>身份证正面 <span style={{ color: '#ff4d4f' }}>*</span></div>
            <Upload
              listType="picture-card"
              maxCount={1}
              fileList={toUploadList(idCardFront, '身份证正面')}
              beforeUpload={(file) => { upload(file as unknown as File, setIdCardFront, 'idCardFront'); return false; }}
              onRemove={() => { setIdCardFront(null); return true; }}
              showUploadList={{ showPreviewIcon: true, showRemoveIcon: true }}
            >
              {!idCardFront && (
                <div><UploadOutlined /><div style={{ marginTop: 4 }}>{uploading === 'idCardFront' ? '上传中…' : '上传'}</div></div>
              )}
            </Upload>
          </Col>
          <Col xs={24} md={12}>
            <div style={{ marginBottom: 6 }}>身份证反面 <span style={{ color: '#ff4d4f' }}>*</span></div>
            <Upload
              listType="picture-card"
              maxCount={1}
              fileList={toUploadList(idCardBack, '身份证反面')}
              beforeUpload={(file) => { upload(file as unknown as File, setIdCardBack, 'idCardBack'); return false; }}
              onRemove={() => { setIdCardBack(null); return true; }}
            >
              {!idCardBack && (
                <div><UploadOutlined /><div style={{ marginTop: 4 }}>{uploading === 'idCardBack' ? '上传中…' : '上传'}</div></div>
              )}
            </Upload>
          </Col>
          <Col xs={24} md={12}>
            <div style={{ marginBottom: 6 }}>签字盖章版委托书（线下签字盖章后上传）</div>
            <Upload
              maxCount={1}
              fileList={toUploadList(signedAuthFile, '签字盖章版委托书')}
              beforeUpload={(file) => { upload(file as unknown as File, setSignedAuthFile, 'signedAuthFile'); return false; }}
              onRemove={() => { setSignedAuthFile(null); return true; }}
            >
              <Button icon={<UploadOutlined />} loading={uploading === 'signedAuthFile'}>上传文件</Button>
            </Upload>
          </Col>
          <Col xs={24} md={12}>
            <div style={{ marginBottom: 6 }}>签字部分截图</div>
            <Upload
              listType="picture-card"
              maxCount={1}
              fileList={toUploadList(signatureScreenshot, '签字部分截图')}
              beforeUpload={(file) => { upload(file as unknown as File, setSignatureScreenshot, 'signatureScreenshot'); return false; }}
              onRemove={() => { setSignatureScreenshot(null); return true; }}
            >
              {!signatureScreenshot && (
                <div><UploadOutlined /><div style={{ marginTop: 4 }}>{uploading === 'signatureScreenshot' ? '上传中…' : '上传'}</div></div>
              )}
            </Upload>
          </Col>
        </Row>
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          message="上传签字盖章版委托书与签字截图后，点击右上角「上传盖章件并完成」即可将状态流转为「已完成」。"
        />
      </Card>

      <LetterPreviewModal
        open={preview.open}
        html={preview.html}
        title={preview.title}
        onClose={() => setPreview({ open: false, html: '', title: '' })}
        onExport={doExportPdf}
      />
    </Card>
  );
}
