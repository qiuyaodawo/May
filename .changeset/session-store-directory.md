---
"@may/session": minor
---

`SessionStore` 新增可选的 `directory` 字段。持久化存储返回自己的目录，内存存储为
`undefined`，宿主可以用它选择同一目录树下的记录位置，例如按请求保存协调记录与
额度账本。既有实现无需修改。
