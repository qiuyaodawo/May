# @may/goal

Independent, durable goal execution composed through public Agent interfaces.
The package depends on `@may/core` and `@may/context`. Base Agent packages do not
import it. Importing the package starts no execution.

Run count, active execution time and token usage are unlimited unless the caller
supplies the corresponding budget. Saved goals retain their recorded limits.

See the [English guide](../../docs/en/guides/goals.md) and
[简体中文指南](../../docs/zh-CN/guides/goals.md) for composition, budgets and recovery.
