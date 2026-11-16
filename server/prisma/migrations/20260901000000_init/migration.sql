-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('PURCHASE', 'LEASE', 'PURCHASE_EXEC', 'LEASE_EXEC', 'EMERGENCY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "realName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAbbr" TEXT,
    "codeAbbr" TEXT,
    "undertaker" TEXT,
    "selfContractAmount" DECIMAL(18,2),
    "industryType" TEXT,
    "provinceCity" TEXT,
    "siteLocation" TEXT,
    "projectAddress" TEXT,
    "materialOrigin" TEXT,
    "status" TEXT,
    "description" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "managerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalPerson" TEXT,
    "legalPhone" TEXT,
    "contractAuthPerson" TEXT,
    "contractAuthPhone" TEXT,
    "contractAuthIdNo" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "address" TEXT,
    "remark" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "projectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subcontractor" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "subcontractorName" TEXT NOT NULL,
    "subcontractContent" TEXT,
    "subcontractId" TEXT,
    "legalPerson" TEXT,
    "authorizedPerson" TEXT,
    "authorizedPersonIdNo" TEXT,
    "projectName" TEXT,
    "idCardFront" TEXT,
    "idCardBack" TEXT,
    "signatureScreenshot" TEXT,
    "signedAuthFile" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EDITING',
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subcontractor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "typeCode" TEXT,
    "contractType" "ContractType",
    "subTypeCode" TEXT,
    "supplierId" TEXT,
    "signDate" TIMESTAMP(3),
    "amount" DECIMAL(18,2),
    "taxRate" DECIMAL(9,4),
    "paymentMethodCode" TEXT,
    "isFramework" TEXT,
    "isSupplement" TEXT,
    "parentContractId" TEXT,
    "yearSeq" TEXT,
    "codeAbbrUsed" TEXT,
    "supplementSeq" INTEGER,
    "supplementTypeCode" TEXT,
    "execStatus" TEXT,
    "status" TEXT,
    "templateId" TEXT,
    "formData" TEXT,
    "materialDescription" TEXT,
    "technicalClauseId" TEXT,
    "qualityClauseId" TEXT,
    "paymentClauseId" TEXT,
    "acceptanceClauseId" TEXT,
    "signedFilePath" TEXT,
    "signedFileName" TEXT,
    "signedDate" TIMESTAMP(3),
    "signedRemark" TEXT,
    "signedAt" TIMESTAMP(3),
    "remark" TEXT,
    "paymentMode" TEXT,
    "monthlyRate" DECIMAL(18,6),
    "graceDays" INTEGER,
    "interestCapRatio" DECIMAL(9,4),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "taskId" TEXT,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractExt" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "financeCode" TEXT,
    "procurementSrc" TEXT,
    "isDirectPurchase" TEXT,
    "bidName" TEXT,
    "currentPayRatio" DECIMAL(9,4),
    "supplierCategory" TEXT,
    "bidStartDate" TIMESTAMP(3),
    "bidWinDate" TIMESTAMP(3),
    "disclosureDate" TIMESTAMP(3),
    "complaint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractExt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractAttachment" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractChangeLog" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "fieldLabel" TEXT,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "operatorId" TEXT,
    "operator" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryCode" TEXT,
    "tags" TEXT,
    "status" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT,
    "pageSetup" TEXT,
    "projectId" TEXT,
    "parentId" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateVariable" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "varKey" TEXT NOT NULL,
    "varLabel" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'MANUAL',
    "defaultValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clause" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "categoryCode" TEXT,
    "type" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "materialBaseId" TEXT,
    "periodYear" INTEGER,
    "periodMonth" INTEGER,
    "entryDate" TIMESTAMP(3),
    "contractId" TEXT,
    "isAsset" TEXT,
    "isSafetyMaterial" TEXT,
    "assetSupervision" TEXT,
    "department" TEXT,
    "personnel" TEXT,
    "assetStatus" TEXT,
    "sourceCode" TEXT,
    "materialCategory" TEXT,
    "materialType" TEXT,
    "materialName" TEXT,
    "steelBrand" TEXT,
    "steelCount" INTEGER,
    "spec" TEXT,
    "unit" TEXT,
    "weighQty" DECIMAL(18,3),
    "deductQty" DECIMAL(18,3),
    "settleQty" DECIMAL(18,3),
    "isWeighed" TEXT,
    "noAcceptReason" TEXT,
    "priceBeforeTax" DECIMAL(18,4),
    "taxRate" DECIMAL(9,4),
    "priceAfterTax" DECIMAL(18,4),
    "amountBeforeTax" DECIMAL(18,2),
    "amountAfterTax" DECIMAL(18,2),
    "supplierId" TEXT,
    "receiveUnit" TEXT,
    "receiver" TEXT,
    "laborContract" TEXT,
    "usePosition" TEXT,
    "isProxy" TEXT,
    "plateNo" TEXT,
    "receiptNo" TEXT,
    "remark" TEXT,
    "subcontractPeriod" TEXT,
    "incomePrice" DECIMAL(18,4),
    "incomeAmount" DECIMAL(18,2),
    "stdPrice" DECIMAL(18,4),
    "stdAmount" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBase" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "categoryLevel1" TEXT,
    "categoryLevel2" TEXT,
    "mdmCode" TEXT,
    "dscCode" TEXT,
    "unit" TEXT,
    "isAsset" BOOLEAN NOT NULL DEFAULT false,
    "isSafetyMaterial" BOOLEAN NOT NULL DEFAULT false,
    "status" INTEGER NOT NULL DEFAULT 1,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractMaterial" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "materialBaseId" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" DECIMAL(18,4),
    "priceBeforeTax" DECIMAL(18,4),
    "taxRatePct" DECIMAL(5,2),
    "priceWithTax" DECIMAL(18,4),
    "totalWithTax" DECIMAL(18,4),
    "remark" TEXT,
    "incomePrice" DECIMAL(18,4),
    "incomeTotal" DECIMAL(18,4),
    "stdPrice" DECIMAL(18,4),
    "stdTotal" DECIMAL(18,4),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractMaterialPool" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "materialBaseId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractMaterialPool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractDraftMaterial" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "materialBaseId" TEXT NOT NULL,
    "seqNo" INTEGER,
    "unit" TEXT,
    "qty" DECIMAL(18,4),
    "priceBeforeTax" DECIMAL(18,4),
    "taxRatePct" DECIMAL(5,2),
    "priceWithTax" DECIMAL(18,4),
    "totalWithTax" DECIMAL(18,4),
    "remark" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractDraftMaterial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT,
    "code" TEXT,
    "typeCode" TEXT,
    "amount" DECIMAL(18,2),
    "deductAmount" DECIMAL(18,2),
    "actualAmount" DECIMAL(18,2),
    "settleDate" TIMESTAMP(3),
    "statusCode" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementLedger" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT,
    "settleMonth" TEXT,
    "monthSettleAmount" DECIMAL(18,2),
    "monthInvoiceAmount" DECIMAL(18,2),
    "settleCount" INTEGER,
    "yearSettleAmount" DECIMAL(18,2),
    "cumPurchaseAmount" DECIMAL(18,2),
    "startSettleAmount" DECIMAL(18,2),
    "monthActualPurchase" DECIMAL(18,2),
    "factoringDiscount" DECIMAL(18,2),
    "overdueInterest" DECIMAL(18,2),
    "yearSettleIncome" DECIMAL(18,2),
    "cumSettleIncome" DECIMAL(18,2),
    "isOnAccount" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SettlementLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT,
    "applyId" TEXT,
    "payMonth" TEXT,
    "amount" DECIMAL(18,2),
    "methodCode" TEXT,
    "payDate" TIMESTAMP(3),
    "receiptUrl" TEXT,
    "statusCode" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contractId" TEXT,
    "goodsCategory" TEXT,
    "settlePeriod" TEXT,
    "invoiceCode" TEXT,
    "invoiceNo" TEXT,
    "typeCode" TEXT,
    "invoiceDate" TIMESTAMP(3),
    "issuer" TEXT,
    "receiver" TEXT,
    "amountBeforeTax" DECIMAL(18,2),
    "taxRate" DECIMAL(9,4),
    "amountWithTax" DECIMAL(18,2),
    "receiveDate" TIMESTAMP(3),
    "reviewStatus" TEXT,
    "responsiblePerson" TEXT,
    "financeTransferStatus" TEXT,
    "imageUrl" TEXT,
    "statusCode" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepaymentAgreement" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "supplierId" TEXT,
    "contractId" TEXT,
    "material" TEXT,
    "signDate" TIMESTAMP(3),
    "settleAmount" DECIMAL(18,2),
    "agreedDebtAmount" DECIMAL(18,2),
    "paidBeforeSign" DECIMAL(18,2),
    "paidAfterSign" DECIMAL(18,2),
    "overdueUnpaid" DECIMAL(18,2),
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepaymentAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepaymentDetail" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "period" INTEGER,
    "amount" DECIMAL(18,2),
    "dueDate" TIMESTAMP(3),
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepaymentDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoringCost" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "seqNo" INTEGER NOT NULL DEFAULT 0,
    "financingDate" TIMESTAMP(3),
    "financingAmount" DECIMAL(18,2),
    "actualReceipt" DECIMAL(18,2),
    "financingInterest" DECIMAL(18,2),
    "handlingFee" DECIMAL(18,2),
    "totalCost" DECIMAL(18,2),
    "settlementMonth" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FactoringCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverdueInterest" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "settlementMonth" TEXT NOT NULL,
    "materialAmount" DECIMAL(18,2),
    "paymentRatio" DECIMAL(9,4),
    "payableAmount" DECIMAL(18,2),
    "payableDate" TIMESTAMP(3),
    "overdueStartDate" TIMESTAMP(3),
    "paymentDate" TIMESTAMP(3),
    "paymentAmount" DECIMAL(18,2),
    "interestAmount" DECIMAL(18,2),
    "overdueDays" INTEGER,
    "monthlyRate" DECIMAL(18,6),
    "overdueInterest" DECIMAL(18,2),
    "waived" BOOLEAN NOT NULL DEFAULT false,
    "prevCumulative" DECIMAL(18,2),
    "remark" TEXT,
    "isSettlementPeriod" BOOLEAN NOT NULL DEFAULT true,
    "periodSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OverdueInterest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetLedger" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "sourceCode" TEXT,
    "categoryL1Code" TEXT,
    "categoryFocusCode" TEXT,
    "name" TEXT,
    "spec" TEXT,
    "unit" TEXT,
    "qty" DECIMAL(18,4),
    "price" DECIMAL(18,2),
    "totalAmount" DECIMAL(18,2),
    "supplierId" TEXT,
    "receiveUnit" TEXT,
    "responsible" TEXT,
    "inUseQty" DECIMAL(18,4),
    "idleQty" DECIMAL(18,4),
    "scrapQty" DECIMAL(18,4),
    "lostQty" DECIMAL(18,4),
    "inUseAmount" DECIMAL(18,2),
    "idleAmount" DECIMAL(18,2),
    "scrapAmount" DECIMAL(18,2),
    "lostAmount" DECIMAL(18,2),
    "remark" TEXT,
    "turnoverCount" INTEGER,
    "originalPrice" DECIMAL(18,2),
    "originalTotal" DECIMAL(18,2),
    "transferOutPrice" DECIMAL(18,2),
    "transferOutAmount" DECIMAL(18,2),
    "receiptOrderId" TEXT,
    "receiptDetailId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "type" TEXT NOT NULL DEFAULT 'SYSTEM',
    "bizType" TEXT,
    "bizId" TEXT,
    "projectId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "module" TEXT,
    "action" TEXT,
    "method" TEXT,
    "url" TEXT,
    "params" TEXT,
    "ip" TEXT,
    "beforeData" TEXT,
    "afterData" TEXT,
    "result" TEXT,
    "message" TEXT,
    "duration" INTEGER,
    "bizType" TEXT,
    "bizId" TEXT,
    "projectId" TEXT,
    "importFile" TEXT,
    "importRows" INTEGER,
    "successCount" INTEGER,
    "failCount" INTEGER,
    "errorFileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportTask" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "moduleName" TEXT,
    "fileName" TEXT,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorFileUrl" TEXT,
    "message" TEXT,
    "projectId" TEXT,
    "userId" TEXT,
    "username" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchiveLog" (
    "id" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3),
    "toDate" TIMESTAMP(3),
    "rows" INTEGER NOT NULL DEFAULT 0,
    "filePath" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArchiveLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DictType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 1,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DictType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DictItem" (
    "id" TEXT NOT NULL,
    "typeCode" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" INTEGER NOT NULL DEFAULT 1,
    "color" TEXT,
    "remark" TEXT,
    "extField1" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DictItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SysParam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SysParam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptOrder" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierName" TEXT,
    "supplierType" TEXT,
    "receivingUnitId" TEXT,
    "receivingUnitName" TEXT,
    "receivingUnitType" TEXT,
    "subcontractId" TEXT,
    "subcontractName" TEXT,
    "supplySubcontractId" TEXT,
    "supplySubcontractName" TEXT,
    "subcontractorId" TEXT,
    "orderDate" TIMESTAMP(3),
    "receiver" TEXT,
    "materialContractId" TEXT,
    "materialContractNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "pushedAt" TIMESTAMP(3),
    "remark" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptOrderDetail" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "materialId" TEXT,
    "categoryLevel1" TEXT,
    "categoryLevel2" TEXT,
    "materialName" TEXT,
    "specModel" TEXT,
    "unit" TEXT,
    "contractQty" DECIMAL(18,4),
    "deliveryQty" DECIMAL(18,4),
    "receivedQty" DECIMAL(18,4),
    "priceBeforeTax" DECIMAL(18,4),
    "taxRate" DECIMAL(9,4),
    "priceWithTax" DECIMAL(18,4),
    "totalPrice" DECIMAL(18,2),
    "usagePart" TEXT,
    "brand" TEXT,
    "remark" TEXT,
    "isAgentPurchase" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptOrderDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "moduleType" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "variables" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskNo" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "purpose" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "stage" INTEGER NOT NULL DEFAULT 0,
    "preMeetingRequired" BOOLEAN NOT NULL DEFAULT false,
    "totalListId" TEXT,
    "contractId" TEXT,
    "procurementCategory" TEXT,
    "techQuality" TEXT,
    "acceptanceMethod" TEXT,
    "paymentMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementTotalItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "materialBaseId" TEXT NOT NULL,
    "materialName" TEXT NOT NULL,
    "spec" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "qty" DOUBLE PRECISION,
    "incomePrice" DOUBLE PRECISION,
    "stdCost" DOUBLE PRECISION,
    "marketPrice" DOUBLE PRECISION,
    "infoPrice" DOUBLE PRECISION,
    "planPrice" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementTotalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FrameworkExplanation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "frameworkIntro" TEXT,
    "negotiation" TEXT,
    "inquiryRows" TEXT,
    "priceCompareRows" TEXT,
    "execution" TEXT,
    "costRows" TEXT,
    "attachments" TEXT,
    "referenceSuppliers" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FrameworkExplanation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreMeetingMinutes" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "meetingTime" TIMESTAMP(3),
    "content" TEXT,
    "host" TEXT,
    "attendees" TEXT,
    "writer" TEXT,
    "reviewer" TEXT,
    "purchaseItems" TEXT,
    "techQuality" TEXT,
    "acceptance" TEXT,
    "paymentTerms" TEXT,
    "costRows" TEXT,
    "inquirySheets" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreMeetingMinutes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementNotice" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "procurementNo" TEXT,
    "procurementTime" TIMESTAMP(3),
    "content" TEXT,
    "techQuality" TEXT,
    "acceptanceMethod" TEXT,
    "paymentMethod" TEXT,
    "contacts" TEXT,
    "contactPhones" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementResultReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "unitCount" INTEGER,
    "openTime" TIMESTAMP(3),
    "openPlace" TEXT,
    "reviewMembers" TEXT,
    "approvedCount" INTEGER,
    "participantCount" INTEGER,
    "abstainCount" INTEGER,
    "validFileCount" INTEGER,
    "suppliers" TEXT,
    "candidates" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementResultReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementPriceCompare" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "pricingMethod" TEXT,
    "benefitAnalysis" TEXT,
    "items" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementPriceCompare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementDocument" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "procurementTime" TIMESTAMP(3),
    "responseDeposit" DOUBLE PRECISION,
    "quoteDescription" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionReport" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "unitName" TEXT NOT NULL,
    "inspectionTime" TIMESTAMP(3),
    "inspectionPlace" TEXT,
    "inspectors" TEXT,
    "content" TEXT,
    "conclusion" TEXT,
    "photos" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Role_code_key" ON "Role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_code_key" ON "Permission"("code");

-- CreateIndex
CREATE UNIQUE INDEX "UserRole_userId_roleId_key" ON "UserRole"("userId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_key" ON "RolePermission"("roleId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_code_key" ON "Project"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Project_codeAbbr_key" ON "Project"("codeAbbr");

-- CreateIndex
CREATE INDEX "Project_createdAt_idx" ON "Project"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_name_key" ON "Supplier"("name");

-- CreateIndex
CREATE INDEX "Subcontractor_projectId_idx" ON "Subcontractor"("projectId");

-- CreateIndex
CREATE INDEX "Subcontractor_subcontractorName_idx" ON "Subcontractor"("subcontractorName");

-- CreateIndex
CREATE INDEX "Contract_projectId_supplierId_idx" ON "Contract"("projectId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_projectId_code_key" ON "Contract"("projectId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ContractExt_contractId_key" ON "ContractExt"("contractId");

-- CreateIndex
CREATE INDEX "DailyReport_projectId_contractId_idx" ON "DailyReport"("projectId", "contractId");

-- CreateIndex
CREATE INDEX "DailyReport_contractId_idx" ON "DailyReport"("contractId");

-- CreateIndex
CREATE INDEX "DailyReport_supplierId_idx" ON "DailyReport"("supplierId");

-- CreateIndex
CREATE INDEX "DailyReport_materialBaseId_idx" ON "DailyReport"("materialBaseId");

-- CreateIndex
CREATE INDEX "DailyReport_entryDate_idx" ON "DailyReport"("entryDate");

-- CreateIndex
CREATE INDEX "DailyReport_projectId_createdAt_idx" ON "DailyReport"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialBase_name_idx" ON "MaterialBase"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialBase_name_spec_key" ON "MaterialBase"("name", "spec");

-- CreateIndex
CREATE INDEX "ContractMaterial_contractId_idx" ON "ContractMaterial"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractMaterial_contractId_materialBaseId_key" ON "ContractMaterial"("contractId", "materialBaseId");

-- CreateIndex
CREATE INDEX "ContractMaterialPool_contractId_idx" ON "ContractMaterialPool"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractMaterialPool_contractId_materialBaseId_key" ON "ContractMaterialPool"("contractId", "materialBaseId");

-- CreateIndex
CREATE INDEX "ContractDraftMaterial_contractId_idx" ON "ContractDraftMaterial"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractDraftMaterial_contractId_materialBaseId_key" ON "ContractDraftMaterial"("contractId", "materialBaseId");

-- CreateIndex
CREATE INDEX "Settlement_projectId_contractId_idx" ON "Settlement"("projectId", "contractId");

-- CreateIndex
CREATE INDEX "Settlement_settleDate_idx" ON "Settlement"("settleDate");

-- CreateIndex
CREATE INDEX "Settlement_projectId_createdAt_idx" ON "Settlement"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SettlementLedger_contractId_settleMonth_idx" ON "SettlementLedger"("contractId", "settleMonth");

-- CreateIndex
CREATE INDEX "SettlementLedger_settleMonth_idx" ON "SettlementLedger"("settleMonth");

-- CreateIndex
CREATE INDEX "SettlementLedger_projectId_createdAt_idx" ON "SettlementLedger"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementLedger_projectId_contractId_settleMonth_key" ON "SettlementLedger"("projectId", "contractId", "settleMonth");

-- CreateIndex
CREATE INDEX "PaymentRecord_contractId_idx" ON "PaymentRecord"("contractId");

-- CreateIndex
CREATE INDEX "PaymentRecord_payMonth_idx" ON "PaymentRecord"("payMonth");

-- CreateIndex
CREATE INDEX "PaymentRecord_projectId_createdAt_idx" ON "PaymentRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_contractId_idx" ON "Invoice"("contractId");

-- CreateIndex
CREATE INDEX "Invoice_settlePeriod_idx" ON "Invoice"("settlePeriod");

-- CreateIndex
CREATE INDEX "Invoice_projectId_createdAt_idx" ON "Invoice"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_projectId_invoiceNo_key" ON "Invoice"("projectId", "invoiceNo");

-- CreateIndex
CREATE INDEX "RepaymentAgreement_contractId_idx" ON "RepaymentAgreement"("contractId");

-- CreateIndex
CREATE INDEX "RepaymentAgreement_supplierId_idx" ON "RepaymentAgreement"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "RepaymentAgreement_projectId_code_key" ON "RepaymentAgreement"("projectId", "code");

-- CreateIndex
CREATE INDEX "FactoringCost_contractId_idx" ON "FactoringCost"("contractId");

-- CreateIndex
CREATE INDEX "OverdueInterest_contractId_settlementMonth_idx" ON "OverdueInterest"("contractId", "settlementMonth");

-- CreateIndex
CREATE INDEX "AssetLedger_projectId_idx" ON "AssetLedger"("projectId");

-- CreateIndex
CREATE INDEX "AssetLedger_receiptOrderId_idx" ON "AssetLedger"("receiptOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetLedger_receiptDetailId_key" ON "AssetLedger"("receiptDetailId");

-- CreateIndex
CREATE INDEX "OperationLog_createdAt_idx" ON "OperationLog"("createdAt");

-- CreateIndex
CREATE INDEX "OperationLog_userId_idx" ON "OperationLog"("userId");

-- CreateIndex
CREATE INDEX "OperationLog_module_action_idx" ON "OperationLog"("module", "action");

-- CreateIndex
CREATE INDEX "ImportTask_status_idx" ON "ImportTask"("status");

-- CreateIndex
CREATE INDEX "ImportTask_createdAt_idx" ON "ImportTask"("createdAt");

-- CreateIndex
CREATE INDEX "ImportTask_userId_idx" ON "ImportTask"("userId");

-- CreateIndex
CREATE INDEX "ArchiveLog_createdAt_idx" ON "ArchiveLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DictType_code_key" ON "DictType"("code");

-- CreateIndex
CREATE INDEX "DictItem_typeCode_idx" ON "DictItem"("typeCode");

-- CreateIndex
CREATE UNIQUE INDEX "DictItem_typeCode_itemCode_key" ON "DictItem"("typeCode", "itemCode");

-- CreateIndex
CREATE UNIQUE INDEX "SysParam_key_key" ON "SysParam"("key");

-- CreateIndex
CREATE INDEX "ReceiptOrder_projectId_orderDate_idx" ON "ReceiptOrder"("projectId", "orderDate");

-- CreateIndex
CREATE INDEX "ReceiptOrder_materialContractId_idx" ON "ReceiptOrder"("materialContractId");

-- CreateIndex
CREATE INDEX "ReceiptOrder_supplierId_idx" ON "ReceiptOrder"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptOrder_projectId_orderNo_key" ON "ReceiptOrder"("projectId", "orderNo");

-- CreateIndex
CREATE INDEX "ReceiptOrderDetail_orderId_idx" ON "ReceiptOrderDetail"("orderId");

-- CreateIndex
CREATE INDEX "ProcurementTemplate_projectId_idx" ON "ProcurementTemplate"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementTemplate_projectId_moduleType_key" ON "ProcurementTemplate"("projectId", "moduleType");

-- CreateIndex
CREATE INDEX "ProcurementTask_projectId_status_idx" ON "ProcurementTask"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementTask_projectId_taskNo_key" ON "ProcurementTask"("projectId", "taskNo");

-- CreateIndex
CREATE INDEX "ProcurementTotalItem_taskId_idx" ON "ProcurementTotalItem"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "FrameworkExplanation_taskId_key" ON "FrameworkExplanation"("taskId");

-- CreateIndex
CREATE INDEX "FrameworkExplanation_projectId_idx" ON "FrameworkExplanation"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PreMeetingMinutes_taskId_key" ON "PreMeetingMinutes"("taskId");

-- CreateIndex
CREATE INDEX "PreMeetingMinutes_projectId_idx" ON "PreMeetingMinutes"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementNotice_taskId_key" ON "ProcurementNotice"("taskId");

-- CreateIndex
CREATE INDEX "ProcurementNotice_projectId_idx" ON "ProcurementNotice"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementResultReport_taskId_key" ON "ProcurementResultReport"("taskId");

-- CreateIndex
CREATE INDEX "ProcurementResultReport_projectId_idx" ON "ProcurementResultReport"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementPriceCompare_taskId_key" ON "ProcurementPriceCompare"("taskId");

-- CreateIndex
CREATE INDEX "ProcurementPriceCompare_projectId_idx" ON "ProcurementPriceCompare"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementDocument_taskId_key" ON "ProcurementDocument"("taskId");

-- CreateIndex
CREATE INDEX "ProcurementDocument_projectId_idx" ON "ProcurementDocument"("projectId");

-- CreateIndex
CREATE INDEX "InspectionReport_projectId_idx" ON "InspectionReport"("projectId");

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_parentContractId_fkey" FOREIGN KEY ("parentContractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractExt" ADD CONSTRAINT "ContractExt_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractAttachment" ADD CONSTRAINT "ContractAttachment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractChangeLog" ADD CONSTRAINT "ContractChangeLog_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateVariable" ADD CONSTRAINT "TemplateVariable_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ContractTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyReport" ADD CONSTRAINT "DailyReport_materialBaseId_fkey" FOREIGN KEY ("materialBaseId") REFERENCES "MaterialBase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractMaterial" ADD CONSTRAINT "ContractMaterial_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractMaterial" ADD CONSTRAINT "ContractMaterial_materialBaseId_fkey" FOREIGN KEY ("materialBaseId") REFERENCES "MaterialBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractMaterialPool" ADD CONSTRAINT "ContractMaterialPool_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractMaterialPool" ADD CONSTRAINT "ContractMaterialPool_materialBaseId_fkey" FOREIGN KEY ("materialBaseId") REFERENCES "MaterialBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDraftMaterial" ADD CONSTRAINT "ContractDraftMaterial_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractDraftMaterial" ADD CONSTRAINT "ContractDraftMaterial_materialBaseId_fkey" FOREIGN KEY ("materialBaseId") REFERENCES "MaterialBase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLedger" ADD CONSTRAINT "SettlementLedger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementLedger" ADD CONSTRAINT "SettlementLedger_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecord" ADD CONSTRAINT "PaymentRecord_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentAgreement" ADD CONSTRAINT "RepaymentAgreement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentAgreement" ADD CONSTRAINT "RepaymentAgreement_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentAgreement" ADD CONSTRAINT "RepaymentAgreement_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentDetail" ADD CONSTRAINT "RepaymentDetail_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "RepaymentAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoringCost" ADD CONSTRAINT "FactoringCost_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverdueInterest" ADD CONSTRAINT "OverdueInterest_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLedger" ADD CONSTRAINT "AssetLedger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLedger" ADD CONSTRAINT "AssetLedger_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationLog" ADD CONSTRAINT "OperationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginLog" ADD CONSTRAINT "LoginLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_materialContractId_fkey" FOREIGN KEY ("materialContractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_subcontractId_fkey" FOREIGN KEY ("subcontractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrder" ADD CONSTRAINT "ReceiptOrder_supplySubcontractId_fkey" FOREIGN KEY ("supplySubcontractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOrderDetail" ADD CONSTRAINT "ReceiptOrderDetail_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ReceiptOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTemplate" ADD CONSTRAINT "ProcurementTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTask" ADD CONSTRAINT "ProcurementTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTotalItem" ADD CONSTRAINT "ProcurementTotalItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementTotalItem" ADD CONSTRAINT "ProcurementTotalItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkExplanation" ADD CONSTRAINT "FrameworkExplanation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FrameworkExplanation" ADD CONSTRAINT "FrameworkExplanation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreMeetingMinutes" ADD CONSTRAINT "PreMeetingMinutes_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreMeetingMinutes" ADD CONSTRAINT "PreMeetingMinutes_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementNotice" ADD CONSTRAINT "ProcurementNotice_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementNotice" ADD CONSTRAINT "ProcurementNotice_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementResultReport" ADD CONSTRAINT "ProcurementResultReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementResultReport" ADD CONSTRAINT "ProcurementResultReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementPriceCompare" ADD CONSTRAINT "ProcurementPriceCompare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementPriceCompare" ADD CONSTRAINT "ProcurementPriceCompare_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementDocument" ADD CONSTRAINT "ProcurementDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementDocument" ADD CONSTRAINT "ProcurementDocument_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProcurementTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionReport" ADD CONSTRAINT "InspectionReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

