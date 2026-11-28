/**
 * 通知域（`notificationApi`）。真理源：`server/src/modules/notification/notification.service.ts`。
 * 无金额字段。
 */

/** 通知行（`Notification`）。 */
export interface NotificationRow {
  id: string;
  userId: string;
  title: string;
  content: string;
  type: string;
  bizType: string | null;
  bizId: string | null;
  projectId: string | null;
  isRead: boolean;
  createdAt: string;
}

/** 通知行**可能的全部键**。 */
export const NOTIFICATION_ROW_KEYS = [
  'id', 'userId', 'title', 'content', 'type', 'bizType', 'bizId', 'projectId', 'isRead', 'createdAt',
] as const;

/** `GET /notifications` 列表查询参数（userId 恒取当前登录用户，非入参）。 */
export interface NotificationListParams {
  page?: number;
  pageSize?: number;
  isRead?: boolean | string;
  projectId?: string;
}

/** `GET /notifications` 列表响应。 */
export interface NotificationListResponse {
  list: NotificationRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /notifications/unread-count`。 */
export interface NotificationUnreadCount {
  count: number;
}
