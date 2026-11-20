-- 项目管理：新增「分管分公司」「分公司简称」两列
ALTER TABLE "Project" ADD COLUMN "branchCompany" TEXT;
ALTER TABLE "Project" ADD COLUMN "branchCompanyAbbr" TEXT;
