---
"@may/application": patch
---

组装的动态提示词发生变化时，使对应 Context 的 provider token 计量失效，后续检查
根据当前提示词估计用量，直到 provider 提供新的 usage。
