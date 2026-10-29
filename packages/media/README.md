# @sortedyuan/media

Image attachments, ordered presentation content, raster validation and filesystem
storage shared by May applications and channels. Runtime dependencies are
`@sortedyuan/may` and `sharp`. Requires Node.js 22.16.0 or later.

`FileMediaStore.save()` and `verify()` coordinate file access across local
processes. Each saved image retains empty `.access` and `.access.gate` files beside
it. Initial access to an older image needs directory write permission to create
these files; subsequent verification only needs read permission on all three files.

See the [English guide](../../docs/en/guides/images.md) and
[简体中文指南](../../docs/zh-CN/guides/images.md) for APIs and supported sources.
