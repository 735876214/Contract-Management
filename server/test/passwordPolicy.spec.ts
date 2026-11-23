import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  WEAK_PASSWORDS,
  checkPasswordStrength,
} from '../src/common/utils/password-policy';

/**
 * 口令强度口径（第 24 轮审计）。
 * 原来只校验「长度 ≥ 6」，`123456` / `admin1` 直接放行——撞库首选目标。
 */
describe('口令强度', () => {
  it('长度下限是 8 位', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 8);
    assert.ok(checkPasswordStrength('ab1') !== null);
    assert.ok(checkPasswordStrength('abcd123') !== null, '7 位必须拒绝');
    assert.equal(checkPasswordStrength('proj2026a'), null);
  });

  it('必须同时含字母与数字', () => {
    assert.match(String(checkPasswordStrength('12345678')), /字母/);
    assert.match(String(checkPasswordStrength('abcdefgh')), /数字/);
    assert.equal(checkPasswordStrength('ab12cd34'), null);
  });

  it('空口令直接拒绝', () => {
    for (const v of ['', null, undefined]) {
      assert.equal(checkPasswordStrength(v), '密码不能为空');
    }
  });

  it('超长口令拒绝（避免 bcrypt 被超长输入拖累）', () => {
    const long = 'a1'.repeat(PASSWORD_MAX_LENGTH);
    assert.match(String(checkPasswordStrength(long)), /不能超过/);
  });

  it('守卫不能空转：默认口令必须被判为弱口令', () => {
    for (const weak of ['123456', 'admin123', 'password', 'admin']) {
      assert.notEqual(checkPasswordStrength(weak), null, weak);
    }
  });

  it('常见弱口令黑名单（长度/字符都合规但仍在撞库字典前排）', () => {
    assert.ok(WEAK_PASSWORDS.size >= 10, '黑名单不能是空壳');
    for (const weak of ['admin123', 'Password123', 'qwerty123', 'cms12345']) {
      assert.match(String(checkPasswordStrength(weak)), /弱口令/, weak);
    }
    // 大小写不敏感
    assert.match(String(checkPasswordStrength('ADMIN123')), /弱口令/);
    // 合规口令不受影响
    assert.equal(checkPasswordStrength('Csc2026x'), null);
  });
});
