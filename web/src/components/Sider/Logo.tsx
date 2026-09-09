import './index.less';
import type { LogoProps } from './types';

/** Logo 组件（需求 5.1）：展开显示完整标题，折叠显示缩写并淡出文字 */
export default function Logo({ collapsed, onClick }: LogoProps) {
  return (
    <div className={`sider-logo${collapsed ? ' is-collapsed' : ''}`} onClick={onClick} aria-hidden={!onClick}>
      <span className="sider-logo__mark">SCM</span>
      <span className="sider-logo__text">供应链管理系统</span>
    </div>
  );
}
