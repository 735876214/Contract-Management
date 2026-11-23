"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 统一计算引擎的**聚合入口**：`import { round2, monthKey } from '@cms/calc'`。
 * 也可以按文件取（`@cms/calc/money`），意图更清楚。
 *
 * 纪律：任何一侧（server / web）都不得再复制计算、舍入、税率、日期格式公式——
 * 前后端口径漂移由 `server/test/*Parity.spec.mts` 锁住。
 */
__exportStar(require("./money"), exports);
__exportStar(require("./numeric"), exports);
__exportStar(require("./rate"), exports);
__exportStar(require("./amounts"), exports);
__exportStar(require("./procurement"), exports);
__exportStar(require("./aggregate"), exports);
__exportStar(require("./time"), exports);
__exportStar(require("./format"), exports);
