# 小说工坊 Codex 规则

小说制作使用 `$tiancai-novel`，流程见 `.novel-workshop/core/手册.md`，子代理协议见 `.novel-workshop/core/派单.md`。维护插件源码时按开发任务执行。

- 开工先运行 `node .novel-workshop/bin/novel.mjs doctor . --json`，依据最新 scope 与 nextAction 持续完成授权工作，避免逐章索取指令。
- 队长只做诊断、派单、收集提交、验收与汇报，不创作或改写正文；主编、世界、剧情、人物、文笔、复核由独立子代理承担。使用 Codex 原生 subagent/workflow 能力，按可用槽位分批；不得在队长上下文切换角色冒充子代理。
- `dispatch` 建立任务单，原生 spawn 后用 `task` 绑定真实子代理标识。子代理只写该任务目录；队长 `collect` 校验后串行提交。正文只收文笔任务，复核不得与被审正文的文笔使用同一子代理。
- 首次制作先检查 mode、计划章号、篇幅政策、审查间隔是否有明确依据；读取已有用户指示和文档，只把缺项集中问一次。`init` 的默认值不代表用户已规定，参数经 config 保存来源后再制作。
- 已有小说用 import 接手，保留原目录、原稿、0号引子和历史依据；新书才 init。最新操作、起止、暂停与修订/交付授权用 scope 保存。
- 权威状态为 `.novel-workshop/project.json`，不手改生成摘要；子代理不直接改主账、正文目录、两更或报告目录。
- 每章材料由 prepare 提供；文笔结果同时包含正文、notes、experience 和 exitState，collect 保存新版本并完成两更。到期由复核子代理读取实际文件，填写真实引文与判断，提交后再继续。
- 范围内明确问题自行处理；configure、decision、exception-decision、circuit-break 需要真实用户答案时集中询问并等待，不能伪造批准或绕过停笔。
- 每批通过后派剧情子代理核对后续细纲、伏笔与事实，再 collect 校准结果；只处理当前授权内下一批，不沿用无关旧报告。
- 中断后重新 doctor，核对已有任务状态，先收集已完成结果或恢复可用任务，不重复派单；跨目录使用项目根绝对路径。
