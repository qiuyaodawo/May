# `@may/plugin-web-api`

`createWebApiPlugin({ handler, port?, host?, server?, id? })` 创建 `host` scope 插件。
`handler` 是宿主提供的 `ServiceToken<WebApiHandler>`，处理
`(request, response, { origin, signal })`；插件提供 `webApiService` 的 `server`、
`url` 和 `close()`。默认监听 `127.0.0.1:3939`，`port: 0` 可以使用系统选择的端口。

插件管理 HTTP listener、请求 Promise 和 socket 连接。宿主提供路由、身份验证、
访问策略、静态文件与错误呈现。Handler 可以通过 signal 结束持续请求。
插件关闭取消 signal、结束连接并等待请求处理和 listener 关闭；重复调用等待同一
关闭过程。传入已监听的 `server` 时，插件接收该 listener 的资源所有权并替换
原来的 request listener；插件关闭会关闭这个 server。

Handler 失败时，已经发送响应的连接会终止，尚未发送的响应返回不包含内部详情的
HTTP 500。创建失败会清理已分配的资源。测试通过实际 HTTP 请求读取文件，保持
流式连接后关闭插件，并重新使用同一端口；同时验证端口占用错误。
