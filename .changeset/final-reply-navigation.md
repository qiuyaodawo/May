---
"@may/tui": minor
---

增加 TranscriptStore.latestReply、TranscriptView.revealLatestReply、
TranscriptView.latestReplyAnchor 和 ScrollView.scrollToAnchor，支持将当前轮次
已经完成的最终回复正文开头显示在顶部，并保持阅读位置。支持历史会话恢复，
明确保留选中回复的完整正文，支持超过通常滚动缓冲区长度的回复。
