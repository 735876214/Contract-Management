import pathlib

ROOT = pathlib.Path('/Users/stromboid/WorkBuddy/2026-09-07-15-59-39/cms/server/src/modules')

def rep(path, old, new, count=1):
    p = ROOT / path
    s = p.read_text(encoding='utf-8')
    n = s.count(old)
    assert n == count, f'FAIL {path}: expected {count} got {n} for >>>{old[:90]}<<<'
    p.write_text(s.replace(old, new), encoding='utf-8')
    print(f'OK  {path}  <- {old[:60]!r}')

# 注入 ImportRunnerService
rep('settlement/settlement.service.ts',
    "    private tpl: ImportTemplateService,\n  ) {}",
    "    private tpl: ImportTemplateService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('asset/asset.service.ts',
    "    private tpl: ImportTemplateService,\n  ) {}",
    "    private tpl: ImportTemplateService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('project/project.service.ts',
    "    private tpl: ImportTemplateService,\n  ) {}",
    "    private tpl: ImportTemplateService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('dict/dict.service.ts',
    "    private sysParam: SysParamService,\n  ) {}",
    "    private sysParam: SysParamService,\n    private runner: ImportRunnerService,\n  ) {}")

# 剩余仍使用 assertImportRows 的服务：repayment / finance / ledger 等（若无则跳过）
print('\nALL DONE (part 4)')
