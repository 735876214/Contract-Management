import { useState } from 'react';
import { Button, Space, Upload, message } from 'antd';
import { FileExcelOutlined, UploadOutlined } from '@ant-design/icons';
import { fileApi } from '@/api/auth';
import { isExcelTemplateFileName, toFileUrl, toStorageKey } from '@/utils/templateFile';

/**
 * 单据模板的 Excel 文件上传字段（受控组件，放进 Form.Item 时由 Form 注入 value/onChange）。
 *
 * 业务口径（2026-10-18）：单据模板**只接受 .xlsx**——`.xlsm` 的宏在 ExcelJS 写出时会丢失，
 * 静默丢宏不可接受。落库用**相对存储键**（`key`），展示时用 `toFileUrl()` 补一次 `/api/files/` 前缀；
 * 历史上存成公开 URL（甚至双前缀）的数据也能正确显示。
 */
export interface DocTemplateFileValue {
  fileUrl: string;
  fileName: string;
}

interface Props {
  value?: DocTemplateFileValue | null;
  onChange?: (v: DocTemplateFileValue | null) => void;
}

const MAX_SIZE = 20 * 1024 * 1024;

export default function DocTemplateExcelField({ value, onChange }: Props) {
  const [uploading, setUploading] = useState(false);
  const file = value || null;

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Upload
        accept=".xlsx"
        maxCount={1}
        showUploadList={false}
        beforeUpload={(f) => {
          if (!isExcelTemplateFileName(f.name)) {
            message.error('仅支持 Excel 工作簿（.xlsx）；.xlsm 的宏会在生成时丢失，请另存为 .xlsx 后上传');
            return Upload.LIST_IGNORE;
          }
          if (f.size > MAX_SIZE) {
            message.error('模板文件不能超过 20MB');
            return Upload.LIST_IGNORE;
          }
          return true;
        }}
        customRequest={async (options: any) => {
          setUploading(true);
          try {
            const arr = await fileApi.upload([options.file as File]);
            const first = arr?.[0];
            // 新接口同时返回 key 与 url；key 是落库口径，url 仅作兼容兜底
            const fileUrl = first?.key || toStorageKey(first?.url);
            if (!fileUrl) throw new Error('上传接口未返回文件键');
            onChange?.({ fileUrl, fileName: first?.fileName || options.file?.name || '模板.xlsx' });
            message.success(`「${first?.fileName || options.file?.name}」上传成功`);
            options.onSuccess?.(first);
          } catch (e) {
            options.onError?.(e);
          } finally {
            setUploading(false);
          }
        }}
      >
        <Button icon={<UploadOutlined />} loading={uploading}>
          {file ? '重新上传' : '上传 Excel 模板'}
        </Button>
      </Upload>
      {file ? (
        <a href={toFileUrl(file.fileUrl)} target="_blank" rel="noreferrer">
          <FileExcelOutlined /> {file.fileName}
        </a>
      ) : (
        <span style={{ color: 'var(--cms-muted-soft)' }}>
          未上传。占位符写在单元格文本里（语法与合同模板一致），生成单据时服务端自动替换。
        </span>
      )}
    </Space>
  );
}
