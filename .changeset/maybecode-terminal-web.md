---
"@may/maybecode": minor
"@may/ui-client": minor
"@may/web-ui": minor
---

MaybeCode 的两个终端界面支持 `/web`，自动打开浏览器并连接当前工作区与 Session。
终端和 Web 共享执行状态及审批，退出终端时关闭 Web 服务。

共享 UI 支持独立事件订阅、由外部宿主管理 controller 生命周期，以及短时有效的
一次性浏览器连接凭据。浏览器自动兑换控制令牌，并在兑换前清除 URL fragment。
