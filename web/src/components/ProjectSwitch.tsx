import { Select } from 'antd';
import { useAuthStore } from '@/store/auth';
import { useResponsive } from '@/hooks/useResponsive';

/**
 * 项目切换下拉（Header 左侧）。
 * 窄屏限宽（docs/08 阶段 1：Header 精简）——否则 220px 固定宽会在手机上把
 * 消息/用户菜单挤出屏幕。
 */
export default function ProjectSwitch() {
  const projects = useAuthStore((s) => s.projects);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const setCurrentProject = useAuthStore((s) => s.setCurrentProject);
  const { isMobile } = useResponsive();

  if (!projects.length) return null;

  return (
    <Select
      style={{ width: isMobile ? 128 : 220 }}
      value={currentProjectId || undefined}
      onChange={(v) => {
        setCurrentProject(v);
        window.location.reload(); // 切换项目后刷新全部页面数据
      }}
      options={projects.map((p: any) => ({ value: p.id, label: `${p.name}` }))}
      placeholder="选择项目"
    />
  );
}
