/**
 * 项目资料归档域（`archiveApi`）。真理源：`server/src/modules/archive/*`。
 * 目录树 + 打包下载地址；无金额字段。
 */

/** 归档目录树节点（`GET /archive/entries`）。形状为宽松的树节点（后端按目录结构生成）。 */
export interface ArchiveEntry {
  key: string;
  title: string;
  /** 是否为目录 */
  isDir?: boolean;
  count?: number;
  children?: ArchiveEntry[];
  [extra: string]: unknown;
}
