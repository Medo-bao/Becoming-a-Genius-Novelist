# ZCode适配

1.0.4 支持 ZCode 原生插件和项目级安装。ZCode 与 Codex 共用技能和 CLI 工作流，队长通过 ZCode 的原生 Agent 与 SendMessage 调度六个岗位。材料、授权范围、版本和复核证据由共享 CLI 核对。

## 安装

原生ZCode插件安装（推荐）：仓库根即插件根，清单位于`.zcode-plugin/plugin.json`，本地市场目录为根级`marketplace.json`（条目`source:"./"`）。在ZCode客户端：

1. 打开 Plugin Marketplace → 添加 → 「添加插件市场」，粘贴本仓库绝对目录（或GitHub仓库地址）。
2. 在该市场下安装「我要成为天才小说作家」插件（Settings → Plugin Management 可查看状态）。
3. 新开聊天后，在输入框技能选择器中点选 `tiancai-novel`，或直接明确要求使用「我要成为天才小说作家」。

安装只登记插件，不运行doctor、init、import或小说制作。原生插件载入ZCode专用技能（`adapters/zcode/skills/tiancai-novel/SKILL.md`）并按自身绝对路径定位内置bin/core，不要求先将技能复制到小说项目。

仍保留项目级部署方式，安装器部署调用边界、技能、共享材料、全部CLI模块和任务目录：

```powershell
node bin/install.mjs --target zcode --dir "E:\小说\项目"
```

项目技能位于 `<项目>/.zcode/skills/tiancai-novel/`。安装器改写技能内的 `.novel-workshop` 链接，并按标记块更新项目 `AGENTS.md`。安装完成后，符合本工坊特征的旧用户级技能会整体移入 `~/.zcode/skill-backups/`，安装输出会列出备份位置。设置 `ZCODE_HOME` 时使用该目录下的 `skill-backups/`。`--no-skill` 只安装核心与边界规则。升级后在新聊天加载技能。

## 只在明确调用时运行

技能frontmatter的description即调用策略：仅当用户明确调用`tiancai-novel`技能、点选本插件或明确要求使用「我要成为天才小说作家」插件时使用；普通“写小说”“续写”“精修”“查看进度”、泛称“使用插件”或使用其他插件均不自动匹配。已有小说目录、旧scope、主账或正文也不代表本次调用授权，安装和源码维护不启动小说流程。项目`AGENTS.md`的调用边界块（由安装器写入）与技能口径一致；目标完成、取消或转向其他工作后不把调用状态沿用到后续请求。

## 六岗位与ZCode原生代理

作者只与队长所在的主会话对话。队长执行dispatch建单，再用ZCode原生工具启动主编、世界、剧情、人物、文笔、复核中的相关子代理；六类岗位独立，队长不写正文。按实际并发槽位分批，已有可用成果复用，不为每章固定启动六个任务。

| Codex原生概念 | ZCode对应 | 用途 |
|---|---|---|
| spawn_agent（只读准备） | `Agent`工具（subagent_type=general-purpose，前台） | 派全新子代理，只读promptPath/contextPath并回执就绪 |
| 真实子代理ID | Agent返回的`agent_<uuid>` | `task --id X --status running --agent <ID> --runtime zcode-native-v1` 绑定 |
| followup_task（唤醒） | `SendMessage`（上下文保留，后台续跑） | 绑定成功后发送开始执行指令；同岗位续单传新路径唤醒 |
| wait_agent | 完成通知 + `TaskOutput(block=false)` | 通知未到只表示暂无结果；不轮询不空转 |
| 中断结果恢复 | 原代理已停止，结果缺失或 JSON 损坏 | `advance --id X --requeue` 重派未提交章并保留原文件 |

任务单不是模型调用，dispatch成功后仍需真正spawn并绑定返回的子代理标识。绑定纪律与Codex一致：首次spawn只读准备，取得真实ID、`task --status running`绑定成功后才SendMessage通知开始，避免子代理先写结果或计量时任务尚未running；同岗位续单先绑定（advance --reuse完成绑定）再SendMessage唤醒。一个代理同一时间一单，岗位身份独立，复核与文笔始终分离；CLI会拒绝同代理跨岗位、一代理两张未收件单及复核复用文笔执行者。子代理只写隔离任务目录，队长collect串行提交正式产物；正文结果必须来自文笔。流程与JSON结构见[派单协议](../core/派单.md)。

## 运行时标识与复用

ZCode绑定与复用统一使用`zcode-native-v1`运行时标识：绑定用`task --id X --status running --agent <ID> --runtime zcode-native-v1`，advance复用加`--runtime zcode-native-v1`，复用查找只匹配同运行时的历史代理，Codex与ZCode代理互不串用。省略`--runtime`时保持`codex-native-v1`旧默认，DSH的`dsh-worker-v1`仍由DSH适配器内部设置，三者互不影响。中断重派`advance --id --requeue`接受全部原生运行时的已绑定单。非法运行时标识在绑定与advance处直接报错。

## 恢复与1.0.3语义

- 恢复时按 `doctor` 的 `nextAction.jobs[].next` 逐单处理。`start` 用于绑定，`collect` 用于收件，`chapter-commit` 用于逐章提交。`result-unreadable` 需先检查文件访问。`check-worker` 或 `invalid-result` 先核对通知与 TaskOutput 状态。确认原代理已停止且结果缺失或 JSON 损坏后再重派。压缩后用完整材料恢复阅读。
- 小批次写作：默认2—3章/单，文笔子代理在自身回合内用Bash运行chapter-commit逐章提交并读取下一章新材料，上下文不足用--stop-after在章边界结束；队长只在批次全部提交后advance收件，后章失败、暂停或终点缩小不撤销已保存章。
- 串行提交：chapter-commit与scope变更共用提交锁；收到「当前项目仍在提交上一项制作操作」时在章边界重试，不直接写project.json。
- 队长分流与受限微修：复核有问题先triage，明确微修只走microfix专用入口；复核子代理保存result.json后自己用Bash运行result-check预检，字段/引文错误由原代理修同一报告（最多3次），正式提交仍由队长collect。
- 暂停/恢复：收到暂停先停止在途子代理再`scope --mode pause`；恢复先登记新授权，`jobs.kept`恢复的复核先收件。

## 省心用法

```text
tiancai-novel 接手当前小说，自动诊断，按已有资料继续至第30章，包含必要返修与复审。
tiancai-novel 只检查并精修第20—30章，暂不续写。
tiancai-novel 将有效通过版本生成阶段稿，交付TXT、Word和EPUB。
```

技能把最新指示写入scope，然后依据doctor.nextAction继续。首次核对模式、计划范围、篇幅政策、复审间隔的来源；现有用户指示或文档能回答的直接登记，configure缺项集中问一次。初始化默认值只是待确认建议，参数已明确不重复询问。如果新安装技能未在已有聊天显示，在目标小说目录新开聊天即可；已登记项目状态不用重述。
