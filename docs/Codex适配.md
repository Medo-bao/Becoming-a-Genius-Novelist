# Codex适配

## 2026-10-28 Codex适配核查（版本保持1.0.2）

原生清单、技能路径、明确调用策略及安装启用状态正常；保留受支持的.codex-plugin格式，不新增清单兼容层、后台服务或自动启动钩子。核查并修复以下衔接问题：

- 项目级技能原先只改了手册链接，运行入口文字仍指向原生包的相对目录。现在统一提供可解析的CLI入口链接，安装器同时转换程序与手册链接；原生版使用包内bin，项目版使用本项目.novel-workshop/bin。
- Codex首次spawn先取得真实ID，原指引未明确绑定前只能只读准备。现在先读取准备，队长task绑定成功后才通知开始；同岗位续单先绑定再followup，避免子代理先写结果或计量时任务尚未running。空闲代理用能触发执行的followup_task唤醒；send_message只追加消息，不能代替唤醒。
- 核心原先允许同一代理同时绑定多张同岗位未收件任务。现在拒绝这类绑定；同单重复绑定保持幂等，旧单收件后可正常复用，同代理跨岗位和文笔自审仍拒绝。
- 共享复核材料原先统一写“无需运行CLI”，与Codex的result-check预检不一致。现在区分DSH宿主自动预检和Codex只读result-check，正式提交仍由队长collect。
- Codex持续制作明确为主会话的等待、收件、真实派单循环：等待超时不表示完成，不只口头宣布下一步就结束；字段/引文错误由原复核修同一报告，最多3次。恢复时区分pending未启动、running存活、已返回未收件和执行者确实丢失，不对未启动单直接collect。

DSH的collect内部自动派下一岗属于DSH适配器能力，CLI不能替Codex调用其原生spawn。Codex使用原生wait/followup和技能指令持续编排；没有为此创建常驻任务、用户侧新聊天或默认目标。没有明确调用时仍不启动制作。


2026-10-27修复已纳入1.0.2：原生入口优先内置CLI，doctor/context给runtime绝对路径；常用命令加--compact，收件和范围变更直接返回diagnosis.nextAction。全书plan与真实lengthPolicy可直接读取，无关范围外历史异常进入historical诊断，当前章和依赖仍有门禁。明确调用策略保持关闭隐式调用，不以维护插件的请求启动小说制作。

支持原生Codex插件安装，当前版本1.0.2；插件清单位于`.codex-plugin/plugin.json`，本地目录位于`.agents/plugins/marketplace.json`。原生插件载入Codex专用技能和内置CLI，不要求先将技能复制到小说项目。安装只登记插件，不运行doctor、init、import或小说制作。

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

原单报告修复：`result-check <小说项目> --task ID`只读运行正式收件校验，不生成报告或关闭问题。复核在结束前预检；字段、评分表达和连续引文错误由原复核子代理修同一result.json，避免新派整批冷读。原材料或正文变更仍按真实影响范围重新审核。DSH的自动岗位续作与内部原代理回叫不要求Codex具有novel_workshop工具。
