/**
 * dev-example 插件对外入口。
 *
 * 与其他模块一样只暴露门面：装配方（`plugins/plugin-modules.generated.ts`）只认这里导出的
 * `DevExampleModule`，不直接引内部文件。
 */
export { DevExampleModule } from './dev-example.module';
