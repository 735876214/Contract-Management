import { Select } from 'antd';
import { useAuthStore } from '@/store/auth';

export default function ProjectSwitch() {
  const projects = useAuthStore((s) => s.projects);
  const currentProjectId = useAuthStore((s) => s.currentProjectId);
  const setCurrentProject = useAuthStore((s) => s.setCurrentProject);

  if (!projects.length) return null;

  return (
    <Select
      style={{ width: 220 }}
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
