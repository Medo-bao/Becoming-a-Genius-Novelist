---
name: tiancai-novel
description: 仅在用户明确调用 $tiancai-novel、点选本插件，或明确要求使用「我要成为天才小说作家」插件时，派六岗位子代理诊断、制作并交付小说。普通写小说、续写、精修、进度查看、泛称使用插件及源码维护不触发。
---

# 自动小说制作

## 调用边界与运行入口

只有本次目标已被用户明确指定使用本插件才执行以下流程。普通写小说、泛称使用插件、查看进度、已有小说或旧scope不构成调用授权。安装、发布或源码维护不启动制作；目标完成、取消或转向其他工作后结束本次调用。

随附[CLI入口](../../../../bin/novel.mjs)、[制作手册](../../../../core/手册.md)、[派单协议](../../../../core/派单.md)与[自动制作协议](../../../../core/自动制作.md)。按当前SKILL.md真实绝对位置解析这些链接，不从工作目录猜程序位置。原生版使用包内bin/core，项目安装器会转换为本项目.novel-workshop/bin/core。后续沿用doctor和context.runtime中的绝对路径。

下文<运行入口>及<小说项目>替换为实际绝对路径。常用命令加--compact；PowerShell解析JSON用ConvertFrom-Json，确需Python时用python -X utf8，避免默认编码损坏中文路径。

## 接手与授权

明确调用但只查看资料/确认进度时，运行`node "<运行入口>" doctor "<小说项目>" --inspect --compact`，只读汇报，不修登记、不派finish、不恢复旧scope。制作中的普通进度提问简报后继续原授权。

只读参数是doctor的--inspect，不存在独立inspect命令。按返回的call.action调用，不把stage名称当CLI命令；Windows检索使用`rg -g "文件匹配模式" 模式 实际目录`，不把带通配符的路径传给rg。

明确要求制作或修复时先doctor，未登记项目按实际文件import或init。终点超过旧全书计划时先config按现行依据更新计划，再scope保存最新操作、范围、来源及revise-approved/交付权限；不先收旧scope任务。模式、全书范围、篇幅、复审间隔先从现有资料取证，仅缺失项集中询问；默认4000字和5章不是作者要求。

用documents按用途、标题和目录检索，再读原文。已有成果完整时不另建文件，必要补充原位修改；分册细纲用config.outlines一次绑定范围，逐章map仍优先。目录、预览及别人摘要不能冒充全文。

仅审查现稿用`scope --mode review`，同时获准返修用`scope --mode revise`。只审时，缺两更由诊断说明，独立复核仍可读稿登记问题及待验收结论。现稿版本晚于旧问题证据时先独立复验，再决定是否继续返修。外部新采用稿与工坊旧版本编号相撞时，核实作者的采用表后用`doctor --fix --adopted <采用表JSON>`，表中`chapters[章号].file`须是实际采用路径。

## 合并交接与原生代理

队长负责判断、分流、编排；主编、世界、剧情、人物、文笔、复核由真实独立子代理按需执行，不每章凑六次调用。队长不写正文，微修仅经专用入口执行。

启动制作或收件后优先合并入口：

```powershell
node "<运行入口>" advance "<小说项目>" --reuse --compact
node "<运行入口>" advance "<小说项目>" --id TASK_ID --reuse --compact
```

advance一次完成收件、版本与状态维护、诊断、下一张材料准备及同批复用绑定。CLI不会替Codex调用原生spawn/followup；handoff.nativeCallRequired要求真实执行，不能只口头宣布下一步就结束。

回包的result为已收件任务，prepared为下一张已准备的任务，handoff给原生交接要求；任务ID取prepared.id，收件结果取result，不读取不存在的task、job或collected字段。归档已完成时按更新后的diagnosis和complete交接结束，不重复archive。

1. handoff.type=spawn：原生spawn只读准备，支持fork_turns时用none，只传项目、prompt/context/result路径及必要作者约束。明确尚未绑定，不写结果、不自行轮询。取得实际ID后执行`task --id TASK_ID --status running --agent 实际ID --compact`，成功后用原生followup_task确认开始。
2. handoff.type=followup：新单已绑定同批同岗位且旧单已收件的代理，实际调用能唤醒执行的followup_task，传完整新路径。send_message只给运行中代理追加信息，不能冒充唤醒。一个代理同时只执行一单，不能跨岗位，复核与文笔始终分离。
3. 恢复时按`doctor.nextAction.jobs[].next`逐单处理。`start`取任务路径并按第1步绑定。`collect`按常规核验收件，`chapter-commit`先提交已保存的当前章结果。`result-unreadable`先核对文件访问。`check-worker`或`invalid-result`先核对原生代理状态，执行者仍运行时等待或让它修正原结果。确认执行者已停止且结果缺失或 JSON 损坏后，用`advance "<小说项目>" --id TASK_ID --requeue --compact`重派未提交章，保留原单文件，再按返回的`spawn`启动新代理。
4. wait_agent采用60000毫秒；等待超时只表示暂无结果，继续等待收件，不表示目标完成。收件后执行handoff或nextAction；到complete、作者暂停/取消或真实需要作者输入才结束制作回合。

收到暂停时停止在途代理，并执行`scope --mode pause --source <用户暂停指示>`。通过预检且已保存的独立复核结果列在`jobs.paused`，可以在`checkpoint`补记接续说明。恢复时先登记新的明确授权，`jobs.kept`中恢复的复核先收件，其余按诊断派单。

保持当前模型和权限，不创建用户侧新聊天代替内部子代理；槽位不足时分批，能力缺失时保存任务并报告，不由队长切帽代写。

## 小批次逐章写作

默认每单连续2—3章，不跨既定复审点或授权终点；长章、上下文不足或规划不齐时派单章，config.writeBatchSize支持1—3，不改变复审间隔。

任务只提供当前章材料。文笔完成整稿与集中自查，填写notes/experience/exitState，保存当前resultPath后提交：

```powershell
node "<运行入口>" chapter-commit "<小说项目>" --task TASK_ID --file "当前resultPath" --compact
```

程序逐章校验并保存正文版本、两更和出章状态，再给下一章的新prompt/context/result路径。必须读取新材料后再写下一章，不能拿第一章依据写完整批，不能最后才交多章大JSON。上下文不足用--stop-after在章边界结束本单，前章保留。全部提交后队长advance收件续作；后章失败、暂停或终点缩小均不撤销已保存章。

单章返修用patches，确需重写须rewriteReason；排版用format，不重抄整章。finish按复审间隔批量提取现稿记录，不夹带正文补丁，补登记不代表通过。draft-check、chapter-commit是正文工作入口。

draft-check的--file优先使用当前resultPath绝对路径，也接受小说项目相对路径或当前章目录内的相对路径；小批次只计量当前章，不能引用已提交章或别单材料。draftFile按同一规则解析。外部新稿尚未完成当前版本的两更时，不沿用旧版出章状态，依据当前正式稿与现行规划接续。

## 队长分流与受限微修

复核有待处理问题时必须先triage，不提前自动派返修。提交`{review,decisions:[{id,route,kind?,reason}]}`，通过triage --source 分流JSON登记：

- ignore仅用于可选建议，保留理由；实质阻塞不能降级忽略。
- micro仅限明确排版、误重复标点或有唯一依据的个别错字，kind为format/punctuation/typo；严重程度与修复工作量分别判断，不以改动字数决定权限。
- 数量、时间、人名、指代、能力限制、动机、因果、场景和结构问题用repair；需要先调整规划时用plan。
- 证据不足或疑似误判用clarify，原复核补充、澄清或依真实证据撤回；真正作者取舍用author集中询问。

分流是当前制作回合的必做步骤，无须逐项请作者批准；未完成会保存待办，不能报完成。分流后按nextAction继续，实质返修仍经文笔与独立复核闭环。

microfix --source 微修JSON指定issues、当前version、唯一原句patches及依据；typo还须引用真实现行作者规则或文风依据，纯排版用format。程序核对授权、版本、唯一匹配及种类范围，保存新版本和完整差异，不覆盖原复核报告。歧义或匹配不唯一时重新triage为repair，不开放队长通用正文写入。

纯排版仅在原独立语义检查、评分、两更有效且阻塞仅来自本次排版时由程序确认字句未变；其他微修独立确认。优先原复核代理，只有确认其全文阅读上下文仍在、依据未变时，advance加--context-retained切换完整差异及相关上下文定点确认。新代理、压缩后丢失上下文、依据变化或声明外差异使用完整材料，不转移别人的阅读证明，不由队长修完自己签认。

复核保存result.json后result-check --task TASK_ID预检；字段、评分表达或连续引文错误由原代理修同一报告，最多3次，保留实质判断，不重派整批冷读。真实执行失败或取消才task --reason；真实版本变化按受影响范围重新审。

## 阅读、质量与收尾

输入分稳定规则、本批规划、当前章正文与变化。同批共享材料只读，相同代理自己完整读过、版本未变且上下文仍在的内容可复用；新代理或上下文丢失读全。prompt/context和变化正文始终读取。复核优先reviewReadings/sharedReviewReading，不重复同内容packets/textFiles；引文指向正式稿originalPath。

经验与注意事项按固定条款、最近轮次和当前章直接依赖提供范围化阅读稿，sharedReadings的sourceRanges标出原文行段，原文件仍可按originalPath回查；读完选定材料不等于通读全部历史。正文、底本和本章细纲不按此规则裁剪。

发现细纲需要同步时，先完成必要的规划修正，再准备最终复验；收尾统计放在进度文档或工坊管理的进度标记块，不混入细纲共规。新记录比较本章、明确依赖与共规的实际细纲；真实修改仍复验。旧记录沿用原有文件依据，不追认已失效的历史结论。

逐章verdict保留独立通过的未变章，只复验未通过及受影响章；跨章问题列齐实际待改章，覆盖完整才关闭。旧问题在resolutions给新版真实证据；红项必阻塞，黄项默认阻塞。已修待验先复核，不反复派修。每批仍派剧情校准下一批细纲、伏笔与事实，保留熔断、破格裁决和最终验收。

首稿按场景连续写，再集中回读承接、底本笔误、代词动作、时序伤情和重复对白。未设比例不自行补到95%，不把4000占位当要求；无作者依据不把井号/缩进偏好变成阻塞。同字数不证明文本相同，返修看comparison。

恢复按最新scope、checkpoint和task路径，核对kept/cancelled，不越过新停止点。historical无关旧提示不阻塞本轮，当前章、直接依赖与有效依据仍检查。正文不贴聊天，仅摘要、路径、字数和判决。

目标完成后程序自动分类归档，nextAction=archive直接执行，不派整理代理。正式正文、现行规划及当前引用保留；暂停、未完成、有未收件任务时保留现场。旧单用task --id查询归档路径，按实际授权导出TXT、DOCX、EPUB和Markdown。


分流只覆盖本次授权内完整包含的问题，范围外独立待办保留至后续授权；不能局部关闭跨章阻塞，应先处理review-scope。按返回的当前diagnosis继续，不因范围外pending反复分流当前已处置项。同章有多类微修时先确认已提交项，再按新版复核报告处理余项。批次draftFile相对当前章resultPath所在目录解析，恢复任务使用当前段的真实结果路径。
