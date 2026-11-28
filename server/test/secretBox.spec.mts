import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSealed,
  openSecret,
  resolveSecretsKey,
  sealSecret,
  SecretBoxError,
  secretsKeyConfigured,
} from '../src/common/crypto/secret-box.ts';

/**
 * 系统参数里密钥类值的静态加密（2026-11-24，借 ApeAdmin 的 Fernet 思路用 aes-256-gcm）。
 *
 * 为什么值得锁：`ai.apiKey` 之前**明文**躺库里，唯一保护是「接口不回显」。
 * 出口过滤管的是「谁看得见」，加密管的是「库/备份被拿走以后还看得见吗」。
 *
 * 这里锁四件事：往返正确、明文存量兼容、没配密钥时的降级口径、密钥变了/密文被改要报可读错误。
 */

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');

function withKey<T>(key: string | undefined, fn: () => T): T {
  const prev = process.env.PARAM_SECRET_KEY;
  if (key === undefined) delete process.env.PARAM_SECRET_KEY;
  else process.env.PARAM_SECRET_KEY = key;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PARAM_SECRET_KEY;
    else process.env.PARAM_SECRET_KEY = prev;
  }
}

describe('密钥的解析', () => {
  it('必须是 base64 的 32 字节；长度不对当作没配（不要半途换算法）', () => {
    assert.ok(resolveSecretsKey(KEY_A));
    assert.equal(resolveSecretsKey(Buffer.alloc(16, 1).toString('base64')), null);
    assert.equal(resolveSecretsKey('not-base64!!'), null);
    assert.equal(resolveSecretsKey(''), null);
    assert.equal(resolveSecretsKey(undefined), null);
  });
});

describe('加密往返', () => {
  it('中文/长文本/符号都能原样还原，且密文带自描述前缀', () => {
    withKey(KEY_A, () => {
      const secrets = ['sk-abc123', '中文密钥·带符号 !@#￥%……&*（）', 'x'.repeat(4096)];
      for (const plain of secrets) {
        const sealed = sealSecret(plain);
        assert.ok(isSealed(sealed), '应带 enc:v1: 前缀');
        assert.ok(!sealed.includes(plain), '密文里不应出现明文');
        assert.equal(openSecret(sealed), plain);
      }
    });
  });

  it('同一个明文两次加密结果不同（随机 IV）', () => {
    withKey(KEY_A, () => {
      assert.notEqual(sealSecret('sk-same'), sealSecret('sk-same'));
    });
  });

  it('已是密文不会二次加密（避免「保存一次套一层」）', () => {
    withKey(KEY_A, () => {
      const once = sealSecret('sk-abc');
      assert.equal(sealSecret(once), once);
    });
  });

  it('空串原样返回（空 = 清除该项，不写占位密文）', () => {
    withKey(KEY_A, () => {
      assert.equal(sealSecret(''), '');
      assert.equal(openSecret(''), '');
    });
  });
});

describe('明文存量兼容与降级口径', () => {
  it('非 enc:v1: 前缀的值按明文放行（老数据不用迁移脚本，重存一次即升级）', () => {
    withKey(KEY_A, () => {
      assert.equal(openSecret('sk-legacy-plain'), 'sk-legacy-plain');
    });
  });

  it('没配 PARAM_SECRET_KEY 时 seal 原样返回明文（否则老部署一保存就 500）', () => {
    withKey(undefined, () => {
      assert.equal(secretsKeyConfigured(), false);
      assert.equal(sealSecret('sk-abc'), 'sk-abc');
      assert.equal(isSealed(sealSecret('sk-abc')), false);
    });
  });

  it('没配密钥却读到密文 → 抛可读错误（不能静默返回空串，那会让人以为密钥丢了）', () => {
    const sealed = withKey(KEY_A, () => sealSecret('sk-abc'));
    withKey(undefined, () => {
      assert.throws(
        () => openSecret(sealed),
        (e: unknown) => {
          assert.ok(e instanceof SecretBoxError);
          assert.match(String((e as Error).message), /PARAM_SECRET_KEY/);
          return true;
        },
      );
    });
  });
});

describe('解密失败要说清原因', () => {
  it('换了密钥 → 认证失败 + 提示是密钥不匹配', () => {
    const sealed = withKey(KEY_A, () => sealSecret('sk-abc'));
    withKey(KEY_B, () => {
      assert.throws(
        () => openSecret(sealed),
        (e: unknown) => {
          assert.ok(e instanceof SecretBoxError);
          assert.match(String((e as Error).message), /不是同一把|篡改/);
          return true;
        },
      );
    });
  });

  it('密文被篡改 → 抛错而不是解出垃圾', () => {
    withKey(KEY_A, () => {
      const sealed = sealSecret('sk-abc');
      const parts = sealed.split(':');
      const ct = Buffer.from(parts[3], 'base64');
      ct[0] = ct[0] ^ 0xff;
      const tampered = [parts[0], parts[1], parts[2], ct.toString('base64')].join(':');
      assert.throws(() => openSecret(tampered), SecretBoxError);
    });
  });

  it('格式不完整的密文 → 明确说格式错，不是笼统失败', () => {
    withKey(KEY_A, () => {
      assert.throws(
        () => openSecret('enc:v1:only-two'),
        (e: unknown) => {
          assert.ok(e instanceof SecretBoxError);
          assert.match(String((e as Error).message), /格式/);
          return true;
        },
      );
    });
  });
});
