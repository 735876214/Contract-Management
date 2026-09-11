import React from 'react';
import { Button, Card, Result } from 'antd';

interface State {
  error: Error | null;
}

/** 全局错误边界：捕获渲染期异常，避免整页白屏/崩溃 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 保留控制台输出便于排查
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}>
        <Card style={{ maxWidth: 560, width: '100%' }}>
          <Result
            status="error"
            title="页面出现异常"
            subTitle={error.message || '渲染时发生未知错误，请重试。'}
            extra={[
              <Button key="retry" type="primary" onClick={() => this.setState({ error: null })}>
                重试
              </Button>,
              <Button key="reload" onClick={() => window.location.reload()}>
                刷新页面
              </Button>,
            ]}
          />
        </Card>
      </div>
    );
  }
}
