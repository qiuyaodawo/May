---
"@may/application": minor
"@may/session": minor
"@may/coordination": minor
"@may/scheduler": minor
"@may/ui-client": minor
"@may/plugin-agent-adapters": minor
"@may/plugin-observability": minor
"@may/plugin-delegation": patch
---

增加经过验证的版本化执行关联信息，连接 scheduler、coordination、Agent adapter、
Session、Run 与模型请求。Session 继续执行记录先前 Run 身份；远程业务去重独立于
trace parent。Scheduler 可选启用遥测，并依赖 Core 的公开接口。

增加可选 service 查询、本地诊断与独立指标服务，以及可复用的 UI 诊断面板。宿主可以
按会话范围查询执行记录、刷新模型能力，并独立管理遥测资源。子 Agent 预算包装保留
模型配置、能力版本和物理请求观察信息。
