---
"@may/ui-client": minor
"@may/web-ui": patch
---

`UiSnapshot` 增加可选的 `resourcesVersion`。资源成员、分页顺序或搜索文本变化时，
Web UI 保留搜索条件及已加载页数，重新读取资源列表。支持完整目录中的新增、删除和重命名。
