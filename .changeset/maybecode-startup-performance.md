---
"@may/maybecode": patch
"@may/application": patch
"@may/tui": patch
"@may/media": patch
---

加快 MaybeCode 启动：CLI 使用按功能加载的 JavaScript 打包文件，图片处理和 Web 服务在使用时加载。Git 初始化合并仓库身份与操作状态查询，并在 checkpoint 操作内复用状态结果，保留初始 checkpoint 和写入前检查。
