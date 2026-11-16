-- 领用单据编号在项目内唯一：并发开单会拿到同一流水号，编号重复污染打印/归档/台账引用
CREATE UNIQUE INDEX "LaborReceivingDoc_projectId_docNo_key" ON "LaborReceivingDoc"("projectId", "docNo");
