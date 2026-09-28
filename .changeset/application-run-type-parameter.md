---
"@may/application": minor
---

`AgentController` 与 `AgentWorkspaceController` 新增可选的 `Run` 类型参数，
`AgentWorkspace` 的类型参数顺序相应调整（`Run` 位于 `Application` 之前）。
产品可以把自己附加在 Run 上的字段（例如请求身份）声明为更具体的类型，
`AgentWorkspace` 返回的 Run 会保留这些字段。默认值仍然是非特化的 `AgentRun`，
未显式填写 `Application` 类型参数的调用无需修改。

破坏性类型变更：使用原第四个类型参数指定 `Application` 的调用，需要在它之前增加
`AgentRun`（或应用自己的 Run 类型），例如
`AgentWorkspace<Event, Extension, Compaction, AgentRun, Application>`。
`AgentWorkspace.open` 的显式类型参数采用相同顺序。
