---
"@sortedyuan/plugin-delivery": minor
---

Allow independently implemented channel names and attachment source fields. ChannelAdapter.name accepts a string, and ChannelAttachmentSource contains a platform string plus bounded string fields validated by the owning adapter. ChannelStore provides generic journal persistence while hosts own application migration checks.

Breaking change: ChannelAttachment.source no longer guarantees Telegram or Feishu fileId/messageId fields. Update attachment readers to validate and read the reference fields required by their own platform. Existing persisted Telegram and Feishu source objects remain readable.
