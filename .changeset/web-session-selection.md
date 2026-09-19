---
"@may/maybecode": minor
"@may/ui-client": minor
"@may/web-ui": minor
---

WebUI 侧栏支持确认删除其它会话。垃圾桶图标在鼠标悬停或键盘聚焦时显示，
触屏设备保持显示。当前会话禁止删除。执行或等待 MCP 交互期间禁用会话切换、
新建和删除。

确认等主操作按钮在悬停时保持主题背景色和清晰文字。

兼容性变更：会话页面跟随宿主当前会话，UiClient.select(id) 执行 session.activate，
selectedId 与 activeId 相同。终端和多个页面同步显示会话切换。客户端和宿主需要
同步升级；程序调用方通过 select(id) 切换会话，通过 history/field API 读取历史。
session.delete 使用 targetId 指定删除对象，并要求 expectedActiveId 校验当前会话。
任务页面保留独立选择。
