/**
 * 渲染层转出：编排类型统一由 src/shared/plan-types.ts 定义（主进程同源）。
 * 保留本文件是为了让画布代码沿用设计稿里的 `canvas/plan-types` 路径。
 */
export type {
  ChatMessage,
  ChatRole,
  ExecutionLocks,
  PlanConflict,
  PlanEvent,
  PlanRecord,
  PlanStatus,
  ReplanOp,
  ReplanTier,
  RouteKind,
  RoutingCapsule,
  StageOutlineEntry,
  StageRecord,
  StageReview,
  StageStatus,
  WaitingReason,
  WorkflowId,
  WorkflowSpec,
  WorkflowStageSpec,
  WorkItem,
  WorkItemModality,
  WorkItemStatus
} from '../../../shared/plan-types'
