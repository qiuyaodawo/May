# 远程协调 Worker

[English](../../en/guides/coordination-remote.md) | **简体中文**

`@may/coordination/remote` 支持在独立 Node.js 进程或主机中运行叶子任务。
仍由一个协调器拥有任务图、授权、依赖、Attempt 和 Handoff；Worker
拥有自己的 Agent 注册表、Session 和持久化派发日志。这不是多写者调度器，
也不是高可用的所有权接管协议。

## 嵌入 Worker

宿主通过普通 `CoordinationAgent`（通常是 `createApplicationAgent()`）
提供模型、工具与 Session 存储。不要从协调器任务输入中接收任意 Agent
定义、工具或模型凭据。

```ts
import { createServer } from "node:http";
import { CoordinationWorker } from "@may/coordination/remote";

// workerAgent 是宿主配置的 CoordinationAgent，使用持久化 Session 存储。
const worker = await CoordinationWorker.open({
  directory: "./worker-data/dispatches",
  token: process.env.MAY_WORKER_TOKEN!,
  agents: { analyst: workerAgent },
  authorize: ({ agent, execution }) =>
    agent === "analyst" && execution.coordinationId === "review-1",
  maxConcurrent: 2,
  maxJobs: 128,
});
const server = createServer(worker.handle);
server.listen(8787, "127.0.0.1");

// 关闭时先停止接收请求，再 await worker.close()。
```

使用随机生成、至少 24 个非空白字符的 Bearer 密钥，放在提示与版本控制之外。
明文 HTTP 只允许回环连接；跨主机连接必须使用 HTTPS 服务。
客户端 URL 必须是无路径、查询、用户信息或 fragment 的源地址。
拒绝重定向和带浏览器 Origin 的请求，不提供 CORS 接口。

Worker 授权独立于协调器策略，在接收与执行前分别检查。注册表固定 Agent
版本，重新打开日志时必须保留对应版本。取消仍需认证和匹配的派发身份，
但撤销执行授权后仍可请求取消。

## 注册远程 Agent

```ts
import { CoordinationRuntime } from "@may/coordination";
import { FileCoordinationStore } from "@may/coordination/file-store";
import { createRemoteAgent } from "@may/coordination/remote";

const remote = createRemoteAgent({
  url: "http://127.0.0.1:8787",
  token: process.env.MAY_WORKER_TOKEN!,
  agent: "analyst",
  version: workerAgent.version,
});
const runtime = await CoordinationRuntime.create({
  id: "review-1",
  store: new FileCoordinationStore("./coordinator-data"),
  policy: { version: "review-policy-v1", authorize: (task) => task.agent === "remote" },
  agents: { remote },
  tasks: [{ id: "review", agent: "remote", input: "审查明确提供的材料。" }],
});
try {
  const snapshot = await runtime.wait();
  // 检查每个任务状态：wait() 也会返回受阻状态。
  console.log(snapshot.tasks.map(({ id, status }) => ({ id, status })));
} finally {
  await runtime.close();
}
```

协调器发送显式任务输入、依赖答案和提供的邮箱/唤醒数据，不发送模型推理、
Provider 凭据或完整 Session 历史。只应向可信 Worker 主机发送这些数据。
支持转发实时非流式事件和活跃审批决定；事件缓冲有上限，Worker 重启后不重放，
持久化 Session 证据才是恢复依据。

## 恢复与取消

Worker 在调用 Agent 前 fsync 接收记录与运行状态。派发身份包含协调、任务、
dispatch id 和 turn。同一身份的重复请求幂等，冲突输入被拒绝。
接收响应丢失时，客户端不会盲目重发执行请求。`recover()` 检查证据；
正在执行或已被 Worker 接收排队的任务返回 `recovery-required`，
而不是 `not-started`。Worker 稳定后可重新打开/恢复协调器以读取持久化结果；
未知外部副作用仍需宿主核实。

取消先持久化意图，再中止执行。完整派发取消请求可先创建取消记录，阻止迟到的
接收请求启动任务。协调器也会向接收结果不明、已不在本地活跃的远程任务发送取消。
网络故障仍可能留下未知结果；取消不是回滚，也不能证明副作用已停止。
迟到的持久化结果仍作为证据保留，不会悄悄丢弃。
`runtime.close()` 也会在释放协调器所有权前请求取消已脱离本地执行、结果不明的
远程工作；关闭不是转为后台继续运行的命令。

打开 Worker 只核对已有 Session 证据，不启动模型或工具。重启后排队工作需要
显式匹配的接收请求才可执行。日志使用独占锁、按序 fsync 记录和大小上限
（默认 64 MiB）。只修复未完成的末尾记录，完整记录损坏时拒绝继续。
崩溃后必须确认旧进程停止，才可人工移除遗留锁。保留 Worker 与 Session
两份存储，不能删除证据来强行重试。

## 范围

- 远程 Worker 是叶子执行器，不提供远程委派、同伴消息或 Handoff 能力 RPC；
  编排保留在协调器端。
- 不自动传输文件、产物或工作副本。每个 Worker 宿主自行配置允许的输入、
  工具与资源策略。
- [共享预算](coordination-resources.md) 是本地单写者账本，不是分布式全局配额
  服务。远程部署需要明确分配宿主预算，协调器传输层本身不计量 Provider 调用。
- 不包含自动租约接管、Worker 发现、负载均衡服务、TLS 证书管理、密钥轮换
  或副作用自动回滚。
- [MaybeCode team 命令](maybecode-team.md) 当前使用本地只读 Agent。
  远程 Worker 与 [生命周期控制](coordination-lifecycle.md) 是宿主 API，
  不是新增模型工具或 CLI 开关。
