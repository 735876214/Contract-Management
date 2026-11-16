-- 红冲票 → 原发票（业务口径 2026-11-12：录红冲票时原票同步作废）
-- 仅红冲票填写；服务端在同一事务里把原票置为 CANCELLED。删红冲票 → SetNull（原票保持已作废）。
ALTER TABLE "Invoice" ADD COLUMN "redOfInvoiceId" TEXT;

CREATE INDEX "Invoice_redOfInvoiceId_idx" ON "Invoice"("redOfInvoiceId");

ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_redOfInvoiceId_fkey"
  FOREIGN KEY ("redOfInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
