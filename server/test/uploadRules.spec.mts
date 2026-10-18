import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDangerousUploadName } from '../src/common/utils/upload-rules.ts';

/** 通用上传的危险类型拦截（静态服务公开，避免存储型 XSS） */
describe('上传文件类型规则', () => {
  it('拦截可执行/可脚本类型（大小写不敏感）', () => {
    for (const name of ['a.html', 'a.SVG', 'x.js', 'run.EXE', 'shell.sh', 'p.ps1', 'x.jsp', 'a.jar']) {
      assert.equal(isDangerousUploadName(name), true, name);
    }
  });

  it('业务常见格式放行', () => {
    for (const name of ['合同.pdf', '照片.JPG', 'invoice.png', '单据.xlsx', '模板.docx', '资料.zip', 'a.rar', 'a.dwg', 'a.txt', 'a.csv']) {
      assert.equal(isDangerousUploadName(name), false, name);
    }
    assert.equal(isDangerousUploadName('无扩展名文件'), false);
    assert.equal(isDangerousUploadName(''), false);
  });
});
