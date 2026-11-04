---
"@sortedyuan/may": minor
"@sortedyuan/maybecode": patch
---

MaybeCode keeps a newly created Session on exit when it holds a goal, so a goal that was started or paused before its first Run can be resumed later. `@sortedyuan/may/goals` exports `GOAL_STATE_KEY`, the Session state key that stores the current goal.
