---
"@may/core": minor
"@may/coordination": minor
"@may/provider-openai": minor
"@may/provider-openai-compatible": minor
"@may/provider-anthropic": minor
"@may/config": minor
---

扩展 Usage 的缓存、reasoning、其他计量、包含关系、完整性与 provider 金额；提供版本化
价格配置和可替换的计价接口。RunBudget、FileSharedBudget 与遥测使用同一计价结果，
费用记录保留币种、来源、版本和完整性。保留现有输入输出 USD 单价配置，USD 预算需要
完整的 USD 计价。OpenAI、兼容 provider 与 Anthropic adapter 保存 provider 计量明细。
共享预算包装透传模型执行前验证，验证过程不消耗预留额度。包装模型动态提供最新的
能力版本、配置和限制，保留能力发现与刷新产生的更新。
已完成响应的 schema 验证失败时保留已知用量并结算一次，错误继续携带已计算费用供
外层预算使用。`settleCall()` 支持可选的已计算费用。计价异常保留已知 token 统计并
将费用完整性标记为 false；响应拒绝和计账失败的原因都会保留。
