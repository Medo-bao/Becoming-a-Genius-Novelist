# 我要成为天才小说作家 · ZCode 规则

本项目使用《我要成为天才小说作家》流水线写小说。核心手册在 `./.novel-workshop/core/手册.md`，先读它；岗位卡与模板在同目录。

## 必守纪律

1. 两条渠道：原创（生成式扩张）/ 改编精修（解析式收敛）。选定后写进 `00-状态.md`，不混用。
2. 阶段门：G0 立项 → G1 人设·大纲·文风 → G2 总纲要 → G3 细纲 → G4 逐章 → G5 成书。门没通过不许跳。
3. 每章动笔前读三件套：`06-细纲/第NNN章.md`、`07-注意事项.md`、`08-经验文档.md`，并回执「目标 / 字数 / 禁忌」。
4. 正文只写 `09-正文/第NNN章-vX.md`；改稿递增版本，绝不覆盖。
5. 每章收尾立刻追加 `07-注意事项.md` 与 `08-经验文档.md`。
6. 每 5 章做批次验收（`10-验收/`），三项 ≥ B 且零 🔴 才继续。
7. 章均 4000 字：3600–4400 绿；±10–20% 黄；超 ±20% 红。
8. 正文不贴聊天：≤200 字摘要 + 路径 + 字数 + 判决。

## 命令

```bash
node .novel-workshop/bin/novel.mjs init  <项目目录> --title 书名 --mode 原创 --chapters 120
node .novel-workshop/bin/novel.mjs status <项目目录>
node .novel-workshop/bin/novel.mjs check  <项目目录>
node .novel-workshop/bin/novel.mjs accept <项目目录> --from 1 --to 5
node .novel-workshop/bin/novel.mjs merge  <项目目录>
```

## 技能

`tiancai-novel` 技能已装在 `~/.zcode/skills/tiancai-novel/`，需要时用 `/skills` 或直接引用。它只是入口，规则以本文件与 `core/手册.md` 为准。

## 长会话提醒

- 压缩/新会话后先读 `00-状态.md` 的「会话交接」段，再做集中验收（批次验收 + 维护细纲 + 经验归并）。
- 交接段只写「下一步要什么」，不粘贴大段设定。
