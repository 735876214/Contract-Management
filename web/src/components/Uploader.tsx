import { useState } from 'react';
import { Upload, Button, message, Space } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { fileApi } from '@/api/auth';

export interface UploadFile {
  fileName: string;
  url: string;
  size: number;
}

interface Props {
  value?: UploadFile[];
  onChange?: (files: UploadFile[]) => void;
  max?: number;
}

/** 附件上传（合同附件、银行回单、发票影像等） */
export default function Uploader({ value = [], onChange, max = 5 }: Props) {
  const [loading, setLoading] = useState(false);

  const customRequest = async ({ file, onSuccess, onError }: any) => {
    try {
      const files = await fileApi.upload([file]);
      onSuccess(files);
    } catch (e: any) {
      onError(e);
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Upload
        customRequest={customRequest}
        fileList={value.map((f, i) => ({ uid: String(i), name: f.fileName, status: 'done' as const, url: f.url }))}
        onRemove={(file) => {
          const next = value.filter((_, i) => String(i) !== file.uid);
          onChange?.(next);
          return true;
        }}
        multiple
      >
        <Button icon={<UploadOutlined />} loading={loading}>上传附件</Button>
      </Upload>
    </Space>
  );
}
