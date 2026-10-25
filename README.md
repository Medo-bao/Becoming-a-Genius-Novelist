# 我要成为天才小说作家

版本1.0.0。自动诊断小说制作状况，在一个主会话中派六岗位子代理持续完成原创/改编的规划、写作、复审、返修与交付。队长只编排与收集，正文由文笔子代理创作，减少作者逐章主动对话。

## 使用

在本项目目录安装到小说项目：

```powershell
node bin/install.mjs --target codex --dir "E:\小说\新书"
```

源码仓库：[Medo-bao/-](https://github.com/Medo-bao/-)。下载发行包并解压，或使用 Git：

```powershell
git clone https://github.com/Medo-bao/-.git tiancai-novel
cd tiancai-novel
```

在该小说目录打开Codex，输入：

```text
$tiancai-novel 自动诊断当前项目，按现有计划继续制作至第30章，包含必要返修和本批复审。
```

也可以要求“只审阅，不改稿”“精修现有章节，暂不续写”“完成全书后交付TXT、Word和EPUB”。智能体将最新范围登记后，在同一会话循环执行，真正缺少作者取舍才集中询问。

首次检查模式、计划章号、篇幅政策、审查间隔是否已有明确来源；已有资料直接沿用，未规定的项集中一次询问并保存。初始化默认值不会静默变成作者要求。

DSH中安装本地bundle后，新会话选择同名预设：

```text
plugin_manager action=install_bundle target="<解压后的插件绝对目录>"
```

DSH与Codex共用核心流程和CLI。DSH使用独立worker preset，子代理不提供shell和再次委派工具，只能写自己已绑定的任务目录；当前无法指定受限worker的DSH workflow入口停止提供，六岗位由原生subagent完成派单。Codex使用原生子代理，工具权限由Codex宿主控制。ZCode专门适配留待后续，原始入口保留。

## 主要能力

- doctor只读识别当前制作状况并给出下一步；可接手既有TXT/MD章稿、0号引子与原目录。
- dispatch/task/collect连接宿主原生子代理：主编、世界、剧情、人物、文笔、复核按需派单，按槽位分批；复核与文笔独立，正式提交按任务动作和章节范围校验。
- scope保存最新有效授权、终点、操作类型和替代历史；停止点变化后保留范围外稿件，不误删、不重复计章。
- prepare提供底本切片、细纲、前章结果、有效要求、相关事实、经验与到期伏笔；改编按原章篇幅诊断。
- write不覆盖旧稿；finish自动维护两更、经验与接续状态。
- accept/review形成带真实引文的复审与问题闭环；要求、事实、入章状态和依赖章版本/出章状态变化后，受影响章重新复验。
- partial阶段稿与final正式全书分开；原作底本、原作分析与改编正文分开，支持TXT、DOCX、EPUB、Markdown。
- DOCX含章节导航、分页和页脚页码；EPUB支持作者、简介、语言、可选封面与目录。
- 破格申请：`record --kind exception` 登记“想突破什么 + 代价 + 范围”，待用户裁决；批准后才进正文。
- 连续返修熔断：同一章连续 `maxRepairRounds`（默认3）次未通过即停，等用户校准，不在错误方向上越修越远。
- 批次复盘校准：每批通过后用 `calibrate` 登记细纲、伏笔与事实的调整，再开下一批。
- 待裁决破格、熔断、未校准批次实际阻止写入口；历史范围不会阻塞当前制作，底本缺失或交付文件丢失会返回可处理的诊断。
- 任务产物拒绝符号链接、目录联接及宿主指令文件，完整校验后才写入；批次校准不能伪造作者恢复，普通复核不能升级最终验收。

## 技术入口

```powershell
node bin/novel.mjs doctor "E:\小说\已有项目" --json
node bin/novel.mjs help
```

CLI不调用外部模型；DSH或Codex的原生子代理执行创作和语义判断，工具维护任务、文件、范围、版本、证据和状态。运行要求Node.js 18+，无第三方运行时依赖。

权威状态为 `.novel-workshop/project.json`，人类可读状态和当前要求摘要自动生成。程序位于 `bin/`，共用流程位于 `core/`，宿主入口位于 `adapters/`。集成验证集中在功能接通后运行 `npm test`，岗位子任务不另跑测试。

详见[使用说明](docs/使用说明.md)、[Codex适配](docs/Codex适配.md)、[派单协议](core/派单.md)、[自动制作协议](core/自动制作.md)、[1.0.0发布说明](docs/1.0.0发布说明.md)、[迭代记录](docs/迭代记录.md)。

## 许可

MIT
