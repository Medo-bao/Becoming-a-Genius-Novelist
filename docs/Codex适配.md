# Codex适配

支持原生Codex插件安装，版本保持1.0.1；插件清单位于`.codex-plugin/plugin.json`，本地目录位于`.agents/plugins/marketplace.json`。原生插件载入Codex专用技能和内置CLI，不要求先将技能复制到小说项目。安装只登记插件，不运行doctor、init、import或小说制作。

在本地插件包目录注册并安装：

```powershell
codex plugin marketplace add "<插件包绝对目录>"
codex plugin add tiancai-novel@tiancai-novel-local
codex plugin list --marketplace tiancai-novel-local --json
```

安装后新开聊天；已有聊天未刷新插件时重启Codex。原生技能按自身实际绝对路径定位内置bin/core，运行命令使用小说项目绝对路径；不会将当前工作目录误作插件资源目录。

仍保留项目级部署方式，安装器部署调用边界、技能、共享材料、全部CLI模块和任务目录：

```powershell
node bin/install.mjs --target codex --dir "E:\小说\项目"
```

项目技能位于`.agents/skills/tiancai-novel/`，调用边界追加到AGENTS.md自己的标记块；有非空AGENTS.override.md时写入该override，保留其他规则。规则只约束插件启用条件，不把整套小说流程注入无关请求。重复安装更新插件拥有的程序、材料与技能，不修改小说登记、正文或旧稿。`--no-skill`仅安装核心与边界规则，不改全局模型或宿主权限。

## 只在明确调用时运行

两个技能入口均设置`policy.allow_implicit_invocation: false`。仅当用户明确调用`$tiancai-novel`、点选本插件或明确要求使用「我要成为天才小说作家」插件时使用；普通“写小说”“续写”“精修”“查看进度”、泛称“使用插件”或使用其他插件均不自动匹配。已有小说目录、旧scope、主账或正文也不代表本次调用授权，安装和源码维护不启动小说流程。

明确调用后，在该次目标范围内自动诊断、派单、收件、修复和归档；目标完成、取消或转向其他工作后，不将调用状态沿用到后续请求。不注册自动启动钩子或常驻MCP工具，不用关键词匹配器代替宿主的调用策略。调用策略依据[官方技能说明](https://learn.chatgpt.com/docs/build-skills)；插件格式和本地目录依据[官方插件打包说明](https://developers.openai.com/plugins/build/plugins)。

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
