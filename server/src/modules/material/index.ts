/**
 * material 模块对外公开入口。
 *
 * 其他模块只允许 `from '../material'`；直接引内部文件会被
 * `scripts/check-module-boundaries.mjs` 判为越界（`auth` 守卫按基础设施白名单例外）。
 */
export { MaterialModule } from './material.module';
export { MaterialService } from './material.service';
// 物资表写入原语：回写基础库计量单位、整体替换合同物资明细走这里，不直接写表
export {
  updateMaterialBaseUnit,
  replaceContractMaterials,
  type ContractMaterialRow,
} from './material-writes';
