import { useState } from 'react';
import { Form, Input, Button, Card, message } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import { useTabsStore } from '@/store/tabs';

export default function Login() {
  const [loading, setLoading] = useState(false);
  const login = useAuthStore((s) => s.login);
  const loadProfile = useAuthStore((s) => s.loadProfile);
  const navigate = useNavigate();

  const onFinish = async (values: any) => {
    setLoading(true);
    try {
      // 上一会话可能残留旧标签/失效项目上下文（如未手动退出就关机重启）；
      // 登录前先清一次，保证进入工作台时是干净的初始状态。
      useTabsStore.getState().reset();
      await login(values.username, values.password);
      await loadProfile();
      message.success('登录成功');
      navigate('/dashboard', { replace: true });
    } catch (e: any) {
      // 错误由 http 拦截器统一提示
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // 奶油底（不是原来的蓝色渐变）：整套视觉的根基是 canvas，登录页也不例外
        background: 'var(--cms-canvas)',
        padding: 16,
      }}
    >
      <Card
        style={{
          width: 400,
          maxWidth: '100%',
          // "color-block first, shadow rare"：卡片靠 hairline 分层，不用重阴影
          border: '1px solid var(--cms-hairline)',
          borderRadius: 'var(--cms-radius-lg)',
          boxShadow: 'none',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div className="cms-serif-title cms-title-page" style={{ marginBottom: 6 }}>
            企业合同管理系统
          </div>
          <div className="cms-hint" style={{ letterSpacing: '1.5px', textTransform: 'uppercase' }}>
            Contract Management System
          </div>
        </div>
        <div style={{ height: 1, background: 'var(--cms-hairline)', margin: '18px 0 20px' }} />
        <Form onFinish={onFinish} size="large" initialValues={{ username: 'admin', password: 'admin123' }}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
        <div className="cms-hint" style={{ marginTop: 16, textAlign: 'center' }}>
          演示账号：admin / admin123
        </div>
      </Card>
    </div>
  );
}
