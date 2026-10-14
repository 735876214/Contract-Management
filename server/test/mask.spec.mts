import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_FIELD_KEYS,
  maskKindOf,
  maskField,
  maskByKey,
  slimSecrets,
} from '../src/common/utils/mask.ts';

/**
 * 敏感字段打码单测（观察日志脱敏白名单）。
 *
 * 起点是一次真实泄漏：操作日志曾把 `/api/auth/login` 的响应体整体落库，
 * 导致 35 条明文 JWT（有效期 7 天）可被「日志」页（权限仅 `system:user`）读到；
 * 另有明文银行账号与身份证号。本测试锁定两件事：
 * ① 白名单命中的键一定被打码；② `slimSecrets` **不得修改入参**（否则会把打码结果返回给前端）。
 */

describe('白名单 maskKindOf', () => {
  it('命中已登记的敏感键（大小写不敏感）', () => {
    assert.equal(maskKindOf('password'), 'PASSWORD');
    assert.equal(maskKindOf('newPassword'), 'PASSWORD');
    assert.equal(maskKindOf('token'), 'TOKEN');
    assert.equal(maskKindOf('Authorization'), 'TOKEN');
    assert.equal(maskKindOf('bankAccount'), 'BANK_ACCOUNT');
    assert.equal(maskKindOf('contractAuthIdNo'), 'ID_NO');
    assert.equal(maskKindOf('authorizedPersonIdNo'), 'ID_NO');
    assert.equal(maskKindOf('legalPhone'), 'PHONE');
    assert.equal(maskKindOf('contactEmail'), 'EMAIL');
  });

  it('未登记的键一律不打码（避免误伤业务字段）', () => {
    for (const k of ['amount', 'name', 'remark', 'contractCode', 'realName', 'id']) {
      assert.equal(maskKindOf(k), null, k);
    }
  });

  it('白名单自身不含明显误伤键（回归防护）', () => {
    for (const k of ['name', 'id', 'amount', 'code', 'title']) {
      assert.ok(!(k in SECRET_FIELD_KEYS), `${k} 不应在敏感键白名单里`);
    }
  });
});

describe('打码方式 maskField', () => {
  it('密码 / 令牌：连长度都不暴露', () => {
    assert.equal(maskField('a', 'PASSWORD'), '******');
    assert.equal(maskField('a-very-long-password', 'PASSWORD'), '******');
    assert.equal(maskField('eyJhbGciOiJIUzI1NiJ9.payload.sig', 'TOKEN'), '******');
  });

  it('银行账号：仅保留后 4 位', () => {
    assert.equal(maskField('6222021234567890123', 'BANK_ACCOUNT'), '****0123');
    assert.equal(maskField('123', 'BANK_ACCOUNT'), '***'); // 过短则全打码
  });

  it('身份证：保留前 6 后 4', () => {
    assert.equal(maskField('11010119900307123X', 'ID_NO'), '110101********123X');
    assert.equal(maskField('1234', 'ID_NO'), '****');
  });

  it('手机号：忽略分隔符，保留前 3 后 4', () => {
    assert.equal(maskField('13800001234', 'PHONE'), '138****1234');
    assert.equal(maskField('138-0000-1234', 'PHONE'), '138****1234');
    assert.equal(maskField('123', 'PHONE'), '******'); // 位数不足 → 整体打码
  });

  it('邮箱：保留前 2 位与域名', () => {
    assert.equal(maskField('zhangsan@example.com', 'EMAIL'), 'zh***@example.com');
    assert.equal(maskField('a@b.com', 'EMAIL'), 'a***@b.com');
    assert.equal(maskField('not-an-email', 'EMAIL'), '******'); // 畸形值（无 @）整体打码
  });

  it('姓名：保留姓氏（供展示层使用，日志白名单未启用）', () => {
    assert.equal(maskField('张三丰', 'NAME'), '张**');
    assert.equal(maskField('张', 'NAME'), '张');
  });

  it('空值原样返回（不把 undefined 变成字符串）', () => {
    for (const v of ['', null, undefined]) {
      assert.equal(maskField(v, 'TOKEN'), '');
    }
  });
});

describe('maskByKey', () => {
  it('敏感键打码，其余原样', () => {
    assert.equal(maskByKey('token', 'abc.def.ghi'), '******');
    assert.equal(maskByKey('amount', 123.45), 123.45);
    assert.equal(maskByKey('remark', '含 token 字样但不打码'), '含 token 字样但不打码');
  });

  it('数组值逐项打码（如 contactPhones: ["138…","139…"]）', () => {
    assert.deepEqual(maskByKey('contactPhones', ['13800001234', '13900005678']), [
      '138****1234',
      '139****5678',
    ]);
  });

  it('null / undefined / 空串保持原值（不产出 ******）', () => {
    assert.equal(maskByKey('token', null), null);
    assert.equal(maskByKey('bankAccount', undefined), undefined);
    assert.equal(maskByKey('bankAccount', ''), '');
  });
});

describe('slimSecrets（深拷贝 + 打码）', () => {
  it('**不修改入参**——打码只作用于返回值', () => {
    const input = { username: 'admin', token: 'real.jwt.value', nested: { bankAccount: '6222021234567890123' } };
    const out = slimSecrets(input) as any;
    assert.equal(out.token, '******');
    assert.equal(out.nested.bankAccount, '****0123');
    // 关键：原对象必须保持原样（拦截器传的是即将返回给前端的响应体）
    assert.equal(input.token, 'real.jwt.value');
    assert.equal(input.nested.bankAccount, '6222021234567890123');
  });

  it('递归处理嵌套对象与数组', () => {
    const out = slimSecrets({
      list: [{ supplierName: 'A', bankAccount: '1234567890', contactPhone: '13800001234' }],
      meta: { token: 't' },
    }) as any;
    assert.equal(out.list[0].bankAccount, '****7890');
    assert.equal(out.list[0].contactPhone, '138****1234');
    assert.equal(out.list[0].supplierName, 'A');
    assert.equal(out.meta.token, '******');
  });

  it('非普通对象（Date / 类实例）原样返回，不破坏类型', () => {
    const d = new Date('2026-10-14T00:00:00Z');
    const out = slimSecrets({ at: d }) as any;
    assert.ok(out.at instanceof Date);
    assert.equal(out.at.getTime(), d.getTime());
  });

  it('循环引用不导致栈溢出', () => {
    const a: any = { token: 'x' };
    a.self = a;
    const out: any = slimSecrets(a);
    assert.equal(out.token, '******');
  });

  it('非对象输入原样返回（含 null / 字符串 / 数字）', () => {
    assert.equal(slimSecrets(null), null);
    assert.equal(slimSecrets('token=abc'), 'token=abc');
    assert.equal(slimSecrets(42), 42);
  });
});
