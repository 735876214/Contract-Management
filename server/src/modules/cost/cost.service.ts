import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { round } from '../../common/utils/money';
import { pickFields } from '../../common/pick-fields';
import { StyledExcelService } from '../../common/services/styled-excel.service';

/**
 * 成本管理（附件需求 2026-10-17 新增一级模块）：分包领用汇总 + 降本创效主材盈亏分析。
 * 两张表都是**结构化台账 + Excel 导出**（无上传附件——业务口径 2026-10-17 修正 4）。
 *
 * 派生值**服务端算、不接受直传**（防两套口径）：
 * - 领用金额 `amount` = qty × unitPrice；
 * - 盈亏额 `profitLoss` = 结算额 − 实际成本（可为负）；盈亏率 = 盈亏额 ÷ 结算额（结算额 0/空 → null）。
 */

const RECEIVING_FIELDS = [
  'subcontractorId', 'subcontractorName', 'period', 'materialName', 'spec', 'unit',
  'qty', 'unitPrice', 'useLocation', 'remark',
];
// 旧手工台账 ProfitLossAnalysis 已删除（2026-10-17 第三批：月度盈亏分析见 monthly-profit-loss.service.ts）

@Injectable()
export class CostService {
  constructor(
    private prisma: PrismaClient,
    private styled: StyledExcelService,
  ) {}

}
