---
name: tiancai-novel
description: 仅在用户明确调用 $tiancai-novel、点选本插件，或明确要求使用「我要成为天才小说作家」插件时，诊断并派六岗位制作、复核和交付小说。普通写小说、续写、精修、进度查看、泛称使用插件及源码维护不触发。
whenToUse: 用户明确要求使用本插件或主动选择同名小说制作预设；不能仅因写小说等任务内容自动匹配。
---

# 我要成为天才小说作家

未明确调用本插件时不执行下述制作流程，不因已有项目登记、旧scope或写作请求自动启动。明确调用后只在该次目标内持续工作；目标完成、取消或转向其他任务后不沿用调用状态。

一个作者会话由队长协调，主编、世界、剧情、人物、文笔、复核各由独立子代理执行。队长不写正文，也不在同一上下文轮流扮演岗位。

## 先读

DSH 预设把运行资产同步到 `$DSH_HOME/novel-workshop/`，未设置时为 `~/.dsh/novel-workshop/`。使用其中的 `bin/novel.mjs`、`core/手册.md` 与 `core/自动制作.md`。项目安装版使用 `<项目>/.novel-workshop/` 内同名路径；若直接从本源码使用，读本技能包根目录的 `core/`、`bin/`，不要把技能目录误作运行目录。

队长先读核心流程和已有项目 `00-状态.md`，在DSH调用 `novel_workshop action=doctor`（其他宿主使用CLI的 `doctor <项目> --json`）。子代理先读分配的任务提示与对应 `core/roles/<岗位>.md`，只执行自己的任务。

## 首次检查参数

新会话的新请求仅“读取docs、查看或确认进度”时，使用DSH `novel_workshop {"action":"doctor","options":{"inspect":true}}`，Codex/CLI用`novel doctor <项目> --inspect --json`。本轮只读汇报，待办放diagnostics，不修登记、不派finish、不据旧scope自动恢复制作。DSH会话只读期间拒绝制作动作；作者明确要求恢复后doctor的inspect设false，再按真实授权续作，无需追加确认。正在执行同一制作任务时，普通进度提问只作简报，随后继续原授权，不因此切换会话只读模式。

`doctor` 的 `configure` 会给出 `missing` 与问题列表。先从用户原话和明确的项目文档补齐已知项；在 DSH 用 `ask_user_question` 只把剩余缺项集中问作者，不把初始默认值当作已确认。

- 渠道：原创或改编精修。
- 计划：起始、终止章号或总章数；执行终点另用 `scope` 保存。
- 篇幅：原创章均目标，或改编随底本的规则；仅在作者规定时设置比例范围。
- 审查间隔：按多少章复核；停止点处仍复核不足一批的尾章。

收到回答以 `config --source "用户原话或明确文档依据"` 保存对应值。缺项未确定时停止依赖它的制作，不先按经验填数。已有确认项不重复问，后续新指令覆盖旧值时记录新依据。

## 派单与收件

现行分册用config.outlines的path/from/to及source一次绑定适用范围，逐章map仍可覆盖；不逐章重复选择同一册。doctor/collect诊断提供nextAction.call（DSH可直接调用），文档检索按需分页。

子代理按prompt和context.requiredReads读全实际输入，复核不回抄contract/stamp；文笔先完成初稿、集中修订后精确计量，已有完整MD/TXT可用draftFile交稿，免重复输出全文。跨章问题affectedChapters与from/to覆盖全部待改正文和出章状态。既有进度文档由程序更新当前状态段，保留原要求与历史，不另建主账或重复询问同步授权。

先用novel_workshop action=documents按kind/query查看现有文档的标题、目录和候选，再read相关段落。等效资料优先复用，config.data.documents将用途绑定为现有路径并附source；默认文件名不是新增文档清单，多版本先分析后选定。策划任务用target/patches原位补充，无缺口时artifacts为空；新建同用途文件须createReason。现有分册细纲按章定位，不另造一套。

| 岗位子代理 | 负责内容 |
|---|---|
| 主编 | 制作目标、立项、阶段方案和裁决建议 |
| 世界 | 世界规则、事实与设定冲突 |
| 剧情 | 总纲、细纲、接续和批次校准 |
| 人物 | 人物动机、关系与行为一致性 |
| 文笔 | 正文、返修及章末状态、注意事项和经验 |
| 复核 | 独立冷读、真实引文、评分和问题判决 |

1. DSH队长只通过novel_workshop专用工具制作。doctor检查当前状态；未登记先import/init，config和scope记录真实来源与作者范围。结构化JSON直接放data，不写临时输入文件。
2. dispatch的options指定role、action、chapter或chapters。工具自动建单、预留真实子代理ID并绑定任务，再以固定tiancai-novel-worker预设启动新上下文；不再手动subagent/task/send_message，不在聊天内联正文或补发下一章。
3. worker先真实read任务提示、context、岗位卡、textFiles及逐章packets与正文视图，用offset/limit分页读完。未读全、工具失败或只有聊天正文不能提交；输入prompt/context/chapters/text只读，结果与辅助产物只写绑定任务目录。宿主在提交result.json时生成独立阅读回执，不能由worker伪造。
4. 等待宿主完成通知，队长collect收件并串行提交。返回的diagnosis已经是下一步，直接续作，不再重复doctor、prepare或accept。相互依赖的正文每单一章，收件取得真实出章状态后再派下一章；槽位不足先等已有任务完成，不轮询。
5. 每个任务使用全新worker，文笔和复核身份独立；不复用文笔去自查并冒充独立复核。普通返修也重新派文笔任务，旧版本保留，复核冷读实际新版本。
6. 工具或材料缺失、任务失败时只把task状态改为failed/cancelled并说明原因，补齐后重新dispatch；不能手填running的agent或接受旧宿主未验证任务。范围缩小时保留仍在范围且依据/权限有效的任务，按scope返回jobs.kept/cancelled处理；暂停或受影响任务仍取消。

DSH队长只有专用制作、只读材料和必要交互/状态工具，没有shell、直接write/edit、手动subagent/workflow或send_message入口。worker提供read、glob、grep、write、edit及novel_draft计量，不能再次派单或询问作者；每次写入核对真实ID、父会话、当前授权和任务，路径拒绝链接越界。模型与权限继承宿主，不指定额外模型。核心手册实际绝对路径可从doctor.runtime.manual取得，不用原生read猜测~路径。

返修材料附manuscript当前稿；默认patches定点修改，保留已修内容，整章重写须rewriteReason。文笔保存结果后用novel_draft精确计量。复核verdict仅passed/rework，旧问题在resolutions逐项给新版证据，程序验证后关闭；可选建议用info或blocking:false，不能把实质矛盾降级。已修待验先复验，不反复派修。整册细纲已按本章和关联章节切片，同批相同长文本只需读取同一份。

Codex使用项目专用技能及原生子代理，保持CLI入口。上述DSH合并步骤不要求Codex具有novel_workshop工具。ZCode专门适配仍留待后续。

## 持续制作

目标完成后的收尾由程序分类归档，不派额外整理子代理。最后收件/交付等完成动作会自动处理；接续旧项目若nextAction为archive，直接执行archive后再报告complete。暂停、未完成、仍有未收件任务时保留现场；doctor --inspect只读，不触发整理。

归档清单见00-状态.md；旧任务用task --id查询归档后目录。默认归档任务/草稿/复核草案/阅读回执，额外过程资料用record material的temporary:true及category登记。正文、现行文档、报告、成书及当前引用不移动，不把陌生文件按名称当垃圾。

- G0 立项 → G1 人设、大纲、文风 → G2 总纲要 → G3 细纲 → G4 逐章 → G5 成书；阶段依据入库后才推进。
- 文笔使用 `prepare` 提供的细纲、底本切片、入章状态、有效要求、事实与经验；章末提交实际两更和出章状态。
- 原创按已规定的章均判断；改编按映射底本与删改理由判断，不擅设篇幅比例或凑字数。
- 按当前 `scope` 的审查间隔和实际停止点安排独立复核；范围缩小或暂停立即生效，不逐章重复索要已有授权。
- 批次通过后由剧情子代理完成范围内校准；破格待裁决或返修熔断时停在对应动作，不能绕过继续写。
- 压缩恢复先运行 `doctor`，核对仍在运行、已完成待收件与失败的任务，继续原任务或收件后再派新任务。
- 正文不贴聊天，只汇报简短摘要、文件路径、字数、判决和当前必须由作者决定的问题。

## 文件契约

```
小说/<书名>/
├─ 00-状态.md  01-设想.md  02-人设/  03-大纲.md  04-文风.md  05-总纲要.md
├─ 06-细纲/第001章.md …
├─ 07-注意事项.md  08-经验文档.md
├─ 09-正文/第001章-v1.md …
├─ 10-验收/第001-005章.md
└─ 11-成书/
```

## 工具

```text
novel_workshop {"action":"doctor","project":"E:\\小说\\新书"}
novel_workshop {"action":"config","data":{"mode":"原创","plan":{"start":1,"end":120},"words":4000,"length":{"type":"fixed"},"interval":5,"source":"作者明确规定的值"}}
novel_workshop {"action":"dispatch","options":{"role":"文笔","action":"write","chapter":1}}
novel_workshop {"action":"collect","options":{"id":"job-0001"}}
```

示例数字只说明命令格式，不能代替作者尚未作出的参数选择。省略project时使用当前小说工作目录；跨目录操作显式提供project。ZCode 专门适配仍留待后续，不能以本技能的存在宣称已经接通其子代理能力。

## 不要做

- 队长写正文，或把同一上下文自评当独立复核
- 子代理并发修改项目登记和正式目标文件
- 缺少参数、细纲或授权时开写，或绕过诊断的阻塞动作
- 覆盖正文旧版本，或未经授权回改已验收章节
- 把失败、取消、未完成的委派收件为成功
