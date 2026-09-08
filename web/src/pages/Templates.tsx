import { useEffect, useState } from 'react';
import {
  Card, Table, Button, Form, Input, Space, Modal, Popconfirm, message, Tag, Drawer, Steps, Alert, Select,
  Row, Col, Tabs, InputNumber, Divider, Typography,
} from 'antd';
import { PlusOutlined, SearchOutlined, FileTextOutlined, HistoryOutlined } from '@ant-design/icons';
import { templateApi, contractApi } from '@/api/business';
import { useTable } from '@/hooks/useTable';
import DictSelect, { DictTag } from '@/components/DictSelect';
import RichTextEditor from '@/components/RichTextEditor';
import { exportWord, printHtml, highlightPlaceholders } from '@/utils/docExport';

/** 模板内容可用变量占位符说明 */
const VARIABLES = [
  '合同编号', '合同名称', '合同类型', '合同额', '税率', '签订日期', '合同约定付款方式',
  '项目名称', '供应商名称', '公司地址', '银行名称', '银行账号', '法人姓名', '法人电话',
  '合同授权人姓名', '合同授权人电话', '合同授权人身份证号', '联系人姓名', '联系人电话', '联系人邮箱',
];

export default function Templates() {
  const { loading, list, params, search, reload, pagination } = useTable<any>(
    (p) => templateApi.list({ ...p, includeHistory: params.includeHistory }),
  );
  const [form] = Form.useForm();
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const [includeHistory, setIncludeHistory] = useState(false);

  // 版本抽屉
  const [versionOpen, setVersionOpen] = useState(false);
  const [versionRow, setVersionRow] = useState<any>(null);
  const [versions, setVersions] = useState<any[]>([]);

  // 生成合同向导
  const [genOpen, setGenOpen] = useState(false);
  const [genStep, setGenStep] = useState(0);
  const [gIsFramework, setGIsFramework] = useState<string>();
  const [gIsSupplement, setGIsSupplement] = useState<string>();
  const [gCats, setGCats] = useState<any[]>([]);
  const [gCatCode, setGCatCode] = useState<string>();
  const [gContracts, setGContracts] = useState<any[]>([]);
  const [gContractId, setGContractId] = useState<string>();
  const [gTemplates, setGTemplates] = useState<any[]>([]);
  const [gTemplateId, setGTemplateId] = useState<string>();
  const [gHtml, setGHtml] = useState<string>('');
  const [genLoading, setGenLoading] = useState(false);

  // 条款库
  const [clauseOpen, setClauseOpen] = useState(false);
  const [clauseModal, setClauseModal] = useState(false);
  const [clauseEditing, setClauseEditing] = useState<any>(null);
  const [clauseForm] = Form.useForm();
  const [clauses, setClauses] = useState<any[]>([]);

  useEffect(() => {
    if (versionOpen && versionRow) {
      templateApi.versions(versionRow.id).then((res: any) => setVersions(res?.list || res || []));
    }
  }, [versionOpen, versionRow]);

  useEffect(() => {
    if (clauseOpen) {
      templateApi.clauses().then((res: any) => setClauses(res?.list || res || []));
    }
  }, [clauseOpen]);

  const openEdit = (row?: any) => {
    setEditing(row || null);
    form.resetFields();
    if (row) form.setFieldsValue(row);
    setModal(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    if (editing) await templateApi.update(editing.id, values);
    else await templateApi.create(values);
    message.success('保存成功');
    setModal(false);
    setEditing(null);
    reload();
  };

  const openVersions = (row: any) => {
    setVersionRow(row);
    setVersionOpen(true);
  };

  const rollback = async (targetId: string) => {
    await templateApi.rollback(versionRow.id, targetId);
    message.success('已回滚到该版本');
    setVersionOpen(false);
    setVersionRow(null);
    reload();
  };

  // ---- 生成合同向导 ----
  const openGen = async () => {
    setGenOpen(true);
    setGenStep(0);
    setGIsFramework(undefined);
    setGIsSupplement(undefined);
    setGCats([]);
    setGCatCode(undefined);
    setGContractId(undefined);
    setGTemplateId(undefined);
    setGHtml('');
    const res: any = await contractApi.options();
    setGContracts(res || []);
  };

  const genNext = async () => {
    if (genStep === 0) {
      if (!gIsFramework) return message.warning('请选择是否框架协议');
      return setGenStep(1);
    }
    if (genStep === 1) {
      if (gIsFramework === 'Y') {
        // 框架协议下无需补充协议，直接跳过
        setGIsSupplement('N');
        const res: any = await templateApi.guideCategories({
          isFramework: gIsFramework,
          isSupplement: 'N',
          contractType: undefined,
        });
        const cats = res?.list || res || [];
        setGCats(
          cats.map((c: any) => ({ value: c.value || c.code || c.categoryCode, label: c.label || c.name || c.categoryName })),
        );
        return setGenStep(2);
      }
      if (gIsSupplement === undefined) return message.warning('请选择是否补充协议');
      const res: any = await templateApi.guideCategories({
        isFramework: gIsFramework,
        isSupplement: gIsSupplement,
        contractType: undefined,
      });
      const cats = res?.list || res || [];
      setGCats(
        cats.map((c: any) => ({ value: c.value || c.code || c.categoryCode, label: c.label || c.name || c.categoryName })),
      );
      return setGenStep(2);
    }
    if (genStep === 2) {
      if (!gCatCode) return message.warning('请选择模板分类');
      const res: any = await templateApi.list({ categoryCode: gCatCode, includeHistory: true });
      setGTemplates(res?.list || res || []);
      return setGenStep(3);
    }
  };

  const genPrev = () => setGenStep((s) => Math.max(0, s - 1));

  const doGenerate = async () => {
    if (!gContractId) return message.warning('请选择合同');
    if (!gTemplateId) return message.warning('请选择模板');
    setGenLoading(true);
    try {
      const res: any = await templateApi.generate({ templateId: gTemplateId, contractId: gContractId });
      const html = res?.html ?? res?.data?.html ?? '';
      setGHtml(html || '<p style="color:#999">生成成功，但未返回 HTML 内容</p>');
      message.success('合同已生成');
    } finally {
      setGenLoading(false);
    }
  };

  const copyHtml = () => {
    navigator.clipboard.writeText(gHtml).then(
      () => message.success('HTML 已复制到剪贴板'),
      () => message.error('复制失败，请手动复制'),
    );
  };

  /** 导出文件名：合同名称-模板名称 */
  const genFileName = () => {
    const c = gContracts.find((x: any) => x.id === gContractId);
    const t = gTemplates.find((x: any) => x.id === gTemplateId);
    return `${c?.name || c?.code || '合同'}-${t?.name || '正文'}`.replace(/[\\/:*?"<>|]/g, '_');
  };

  // ---- 条款库 ----
  const openClauseEdit = (row?: any) => {
    setClauseEditing(row || null);
    clauseForm.resetFields();
    if (row) clauseForm.setFieldsValue(row);
    setClauseModal(true);
  };

  const submitClause = async () => {
    const values = await clauseForm.validateFields();
    if (clauseEditing) await templateApi.updateClause(clauseEditing.id, values);
    else await templateApi.createClause(values);
    message.success('保存成功');
    setClauseModal(false);
    setClauseEditing(null);
    const res: any = await templateApi.clauses();
    setClauses(res?.list || res || []);
  };

  const removeClause = async (id: string) => {
    await templateApi.removeClause(id);
    message.success('已删除');
    const res: any = await templateApi.clauses();
    setClauses(res?.list || res || []);
  };

  const onSearch = (v: any) => {
    search({ ...v, includeHistory });
  };

  const toggleHistory = (checked: boolean) => {
    setIncludeHistory(checked);
    search({ includeHistory: checked });
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="合同模板管理"
        extra={
          <Space>
            <Button icon={<FileTextOutlined />} onClick={openGen}>生成合同</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit()}>新增模板</Button>
          </Space>
        }
      >
        <Form layout="inline" style={{ marginBottom: 16, rowGap: 8 }} onFinish={onSearch}>
          <Form.Item name="keyword"><Input placeholder="模板名称关键词" allowClear prefix={<SearchOutlined />} /></Form.Item>
          <Form.Item name="categoryCode"><DictSelect typeCode="contract_template_category" placeholder="模板分类" /></Form.Item>
          <Form.Item>
            <label style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={includeHistory} onChange={(e) => toggleHistory(e.target.checked)} /> 显示历史版本
            </label>
          </Form.Item>
          <Form.Item><Button type="primary" htmlType="submit">查询</Button></Form.Item>
        </Form>

        <Table
          rowKey="id"
          loading={loading}
          dataSource={list}
          pagination={pagination}
          scroll={{ x: 1200 }}
          columns={[
            { title: '模板名称', dataIndex: 'name', width: 240, fixed: 'left' },
            { title: '模板分类', dataIndex: 'categoryCode', width: 140, render: (v) => <DictTag typeCode="contract_template_category" value={v} /> },
            { title: '标签', dataIndex: 'tags', width: 160, render: (v) => (v ? v.split(',').filter(Boolean).map((t: string) => <Tag key={t}>{t}</Tag>) : '-') },
            { title: '版本号', dataIndex: 'version', width: 90, render: (v) => <Tag color="blue">v{v ?? 1}</Tag> },
            { title: '状态', dataIndex: 'status', width: 100, render: (v) => <DictTag typeCode="yes_no" value={v} /> },
            { title: '创建时间', dataIndex: 'createdAt', width: 180, render: (v) => v?.slice(0, 19).replace('T', ' ') },
            {
              title: '操作',
              width: 240,
              fixed: 'right',
              render: (_, row) => (
                <Space size={4}>
                  <Button type="link" size="small" icon={<HistoryOutlined />} onClick={() => openVersions(row)}>版本</Button>
                  <Button type="link" size="small" onClick={() => openEdit(row)}>编辑</Button>
                  <Popconfirm title="删除后该模板所有版本将被移除" onConfirm={async () => { await templateApi.remove(row.id); message.success('已删除'); reload(); }}>
                    <Button type="link" size="small" danger>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="条款库" extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => openClauseEdit()}>新增条款</Button>}>
        <Button type="link" style={{ padding: 0, marginBottom: 8 }} onClick={() => setClauseOpen((o) => !o)}>
          {clauseOpen ? '收起条款列表' : '展开条款列表'}
        </Button>
        {clauseOpen && (
          <Table
            rowKey="id"
            size="small"
            dataSource={clauses}
            pagination={{ pageSize: 10, showTotal: (t: number) => `共 ${t} 条` }}
            scroll={{ x: 900 }}
            columns={[
              { title: '条款标题', dataIndex: 'title', width: 240 },
              { title: '分类', dataIndex: 'categoryCode', width: 160, render: (v) => <DictTag typeCode="contract_template_category" value={v} /> },
              { title: '内容', dataIndex: 'content', width: 400, ellipsis: true },
              {
                title: '操作',
                width: 160,
                render: (_, row) => (
                  <Space size={4}>
                    <Button type="link" size="small" onClick={() => openClauseEdit(row)}>编辑</Button>
                    <Popconfirm title="确认删除该条款？" onConfirm={() => removeClause(row.id)}>
                      <Button type="link" size="small" danger>删除</Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 新增/编辑模板 */}
      <Modal
        title={editing ? '编辑模板' : '新增模板'}
        open={modal}
        onOk={submit}
        onCancel={() => setModal(false)}
        width={760}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col xs={24} md={12}>
              <Form.Item name="name" label="模板名称" rules={[{ required: true }]}><Input placeholder="如 采购合同模板" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="categoryCode" label="模板分类" rules={[{ required: true }]}>
                <DictSelect typeCode="contract_template_category" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="tags" label="标签"><Input placeholder="多个标签用逗号分隔" /></Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item name="status" label="状态" initialValue="Y">
                <DictSelect typeCode="yes_no" />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="可用变量占位符（在模板内容中使用如 {合同编号}、{供应商名称} 等，生成时将自动替换）"
                description={VARIABLES.map((v) => <Tag key={v}>{`{${v}}`}</Tag>)}
              />
            </Col>
            <Col xs={24}>
              <Form.Item name="content" label="模板内容" rules={[{ required: true, message: '请填写模板内容' }]}>
                <RichTextEditor variables={VARIABLES} minHeight={360} placeholder="在此编辑合同正文，可点击「插入变量」把占位符插入到光标处" />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      {/* 版本抽屉 */}
      <Drawer title="版本历史" width={560} open={versionOpen} onClose={() => { setVersionOpen(false); setVersionRow(null); }}>
        <Table
          rowKey="id"
          size="small"
          dataSource={versions}
          pagination={false}
          columns={[
            { title: '版本号', dataIndex: 'version', width: 90, render: (v) => <Tag color="blue">v{v}</Tag> },
            { title: '修改人', dataIndex: 'operator', width: 120 },
            { title: '时间', dataIndex: 'createdAt', render: (v) => v?.slice(0, 19).replace('T', ' ') },
            {
              title: '操作',
              width: 100,
              render: (_, row) => (
                <Popconfirm title="回滚后将基于该版本创建新版本" onConfirm={() => rollback(row.id)}>
                  <Button type="link" size="small">回滚</Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Drawer>

      {/* 生成合同向导 */}
      <Modal
        title="生成合同"
        open={genOpen}
        onCancel={() => setGenOpen(false)}
        footer={
          gHtml
            ? [
                <Button key="close" onClick={() => setGenOpen(false)}>关闭</Button>,
                <Button key="copy" onClick={copyHtml}>复制 HTML</Button>,
                <Button key="word" type="primary" onClick={() => exportWord(gHtml, `${genFileName()}.doc`)}>导出 Word</Button>,
              ]
            : [
                <Button key="prev" disabled={genStep === 0} onClick={genPrev}>上一步</Button>,
                genStep < 3
                  ? <Button key="next" type="primary" onClick={genNext}>下一步</Button>
                  : <Button key="gen" type="primary" loading={genLoading} onClick={doGenerate}>生成</Button>,
              ]
        }
        width={820}
        destroyOnClose
      >
        <Steps
          current={genStep}
          size="small"
          style={{ marginBottom: 24 }}
          items={[
            { title: '框架协议' },
            { title: '补充协议' },
            { title: '选择分类' },
            { title: '生成' },
          ]}
        />
        <div style={{ minHeight: 240 }}>
          {genStep === 0 && (
            <Form layout="vertical">
              <Form.Item label="是否框架协议" required>
                <DictSelect typeCode="yes_no" value={gIsFramework} onChange={setGIsFramework} placeholder="请选择" />
              </Form.Item>
            </Form>
          )}
          {genStep === 1 && (
            <Form layout="vertical">
              <Form.Item label="是否补充协议" required>
                <DictSelect
                  typeCode="yes_no"
                  value={gIsSupplement}
                  onChange={setGIsSupplement}
                  disabled={gIsFramework === 'Y'}
                  placeholder={gIsFramework === 'Y' ? '框架协议无需补充协议' : '请选择'}
                />
              </Form.Item>
              {gIsFramework === 'Y' && (
                <Alert type="info" showIcon message="已选择框架协议，补充协议步骤自动跳过。" />
              )}
            </Form>
          )}
          {genStep === 2 && (
            <Form layout="vertical">
              <Form.Item label="选择模板分类" required>
                <Select
                  style={{ minWidth: 200 }}
                  value={gCatCode}
                  onChange={(v) => setGCatCode(v)}
                  placeholder="请选择模板分类"
                  options={gCats}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Form>
          )}
          {genStep === 3 && (
            <Form layout="vertical">
              <Form.Item label="选择合同" required>
                <Select
                  style={{ minWidth: 200 }}
                  value={gContractId}
                  onChange={(v) => setGContractId(v)}
                  placeholder="请选择合同"
                  options={gContracts.map((c: any) => ({ value: c.id, label: `${c.code || ''} ${c.name || ''}`.trim() }))}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
              <Form.Item label="选择模板" required>
                <Select
                  style={{ minWidth: 200 }}
                  value={gTemplateId}
                  onChange={(v) => setGTemplateId(v)}
                  placeholder="请选择模板"
                  options={gTemplates.map((t: any) => ({ value: t.id, label: `${t.name || ''} (v${t.version || 1})` }))}
                  showSearch
                  optionFilterProp="label"
                />
              </Form.Item>
            </Form>
          )}
          {gHtml && (
            <div>
              <Space style={{ marginBottom: 8 }} wrap>
                <Button onClick={copyHtml} ghost>复制 HTML</Button>
                <Button type="primary" onClick={() => exportWord(gHtml, `${genFileName()}.doc`)}>导出 Word</Button>
                <Button onClick={() => printHtml(gHtml, genFileName())}>打印 / 存为 PDF</Button>
              </Space>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message="黄色高亮部分为未被替换的变量占位符，请核对合同或供应商信息是否完整"
              />
              <div
                style={{ border: '1px solid #f0f0f0', borderRadius: 6, padding: 16, background: '#fff', maxHeight: 420, overflow: 'auto' }}
                dangerouslySetInnerHTML={{ __html: highlightPlaceholders(gHtml) }}
              />
            </div>
          )}
        </div>
      </Modal>

      {/* 新增/编辑条款 */}
      <Modal
        title={clauseEditing ? '编辑条款' : '新增条款'}
        open={clauseModal}
        onOk={submitClause}
        onCancel={() => setClauseModal(false)}
        width={640}
        destroyOnClose
      >
        <Form form={clauseForm} layout="vertical">
          <Form.Item name="title" label="条款标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="categoryCode" label="分类">
            <DictSelect typeCode="contract_template_category" />
          </Form.Item>
          <Form.Item name="content" label="条款内容" rules={[{ required: true }]}>
            <RichTextEditor variables={VARIABLES} minHeight={200} placeholder="条款正文，支持富文本排版与变量占位符" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
