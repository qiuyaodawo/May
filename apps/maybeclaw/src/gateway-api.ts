import type { AgentGateway } from "./gateway.js";

/** 查询经过身份校验，结果为独立数据快照。 */
export interface GatewayQueries extends Pick<AgentGateway,
  "sessions" | "session" | "messages" | "tasks" | "task" | "approvals" | "bindings" | "deliveries" | "delivery" |
  "events" | "legacyTasks" | "legacyTask" | "coordinationSnapshots" | "entryDefaults" | "configuration" | "status"
> {}

/** 控制端使用的会话、执行、审批和配置操作。 */
export interface GatewayController extends GatewayQueries, Pick<AgentGateway,
  "observe" | "handle" | "adapter" | "updateSession" | "setSessionAdmins" | "manageSession" | "stop" | "updateAgent" |
  "resolveApproval" | "retryDelivery" | "recoverTask" | "dispatchTask" | "listPermissionRules" | "createPermissionRule" | "revokePermissionRule"
> {}

/** HTTP 宿主拥有配置位置和关闭能力。 */
export interface GatewayServerController extends GatewayController, Pick<AgentGateway, "options" | "close"> {}

/** 渠道宿主拥有输入接收和投递处理所需的业务接口。 */
export interface GatewayChannelController extends Pick<AgentGateway,
  "options" | "channels" | "changed" | "status" | "recordChannelChange" | "setMemberAccess" | "maintain" |
  "resolveTargets" | "adapter" | "handle" | "restore" | "close"
> {}
