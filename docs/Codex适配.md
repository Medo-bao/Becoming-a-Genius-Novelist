# Codex适配

安装器部署项目规则、技能、共享材料、全部CLI模块和任务目录。进入小说项目使用 `$tiancai-novel`，以自然语言给出目标即可。

```powershell
node bin/install.mjs --target codex --dir "E:\小说\项目"
```

技能位于 `.agents/skills/tiancai-novel/`，规则追加到 AGENTS.md 自己的标记块；有非空 AGENTS.override.md 时写入实际生效的 override，保留其他规则。重复安装更新插件拥有的程序、材料与技能，不修改小说登记、正文或旧稿。`--no-skill` 仅安装核心与规则，不改全局模型或宿主设置。

## 省心用法

```text
$tiancai-novel 接手当前小说，自动诊断，按已有资料继续至第30章，包含必要返修与复审。
$tiancai-novel 只检查并精修第20—30章，暂不续写。
$tiancai-novel 将有效通过版本生成阶段稿，交付TXT、Word和EPUB。
```

技能把最新指示写入 scope，然后依据 doctor.nextAction 继续。首次核对模式、计划范围、篇幅政策、复审间隔的来源；现有用户指示或文档能回答的直接登记，configure 缺项集中问一次。初始化默认值只是待确认建议，参数已明确不重复询问。

## 六岗位与主会话

作者只与队长所在的主会话对话。队长执行 dispatch 建单，再用 Codex 原生 subagent/workflow 启动主编、世界、剧情、人物、文笔、复核中的相关子代理；六类岗位独立，队长不写正文。按实际并发槽位分批，已有可用成果复用，不为每章固定启动六个任务。

原生工具名称以当前环境为准，常见为 collaboration.spawn_agent/send_message/followup_task/wait_agent。任务单不是模型调用，dispatch 成功后仍需真正 spawn 并绑定返回的子代理标识。无需额外固定模型、自建后台或创建用户侧新聊天。当前环境不提供子代理时保存任务并提示能力缺失，不回退成同上下文切帽。

子代理只写隔离任务目录，队长 collect 串行提交正式产物；正文结果必须来自文笔，复核须使用与文笔不同的子代理。相关材料发生变化或授权缩小时先重核任务，不能强行收集旧结果。流程与JSON结构见[派单协议](../core/派单.md)。

Codex通过技能与CLI恢复，无需DSH钩子。恢复后doctor核对状态与已有任务，再收集或续派。工具验证CLI入口的任务、角色、范围和依据；Codex任意shell写文件不属于CLI控制范围，因此项目规则要求子代理只写自己的任务目录。

当前原生子代理使用方式依据[官方Subagents说明](https://learn.chatgpt.com/docs/agent-configuration/subagents)；技能发现与规则层级见[技能说明](https://learn.chatgpt.com/docs/build-skills)、[AGENTS.md说明](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。如果新安装技能未在已有聊天显示，在目标小说目录新开聊天即可；已登记项目状态不用重述。
