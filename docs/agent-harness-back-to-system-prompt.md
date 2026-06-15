# Agent Harness: Back to SYSTEM PROMPT

## 太长不读

最近看 Phistory 抓到的几个 Coding Agent 的 System Prompt，原本只是想比较 Claude Code、Codex 和 Pi 到底写了什么，后来发现真正有意思的不是 prompt 文本本身，而是它们背后暴露出来的 Agent Harness 设计。

System Prompt 不是 Harness 的全部，但它是 Harness 暴露给模型的接口层：告诉模型自己是谁、能用什么工具、怎么使用工具、什么时候该停、哪些边界不能碰。

Pi、Codex、Claude Code 刚好代表三种复杂度：

- Pi 是最小执行闭环：`read/write/edit/bash`
- Codex 是工程协作协议：把模型约束成可靠的软件工程师
- Claude Code 是工作流运行时：让模型操作一整套任务、工具和状态系统

这篇作为 Harness 系列开篇，不做 prompt 猎奇，先从最容易观察的一层开始，看一个 Agent 是怎么被组织成工作系统的。

## 为什么从 System Prompt 开始

过去大家聊 System Prompt，常常会把它当成某种隐藏咒语，好像只要拿到那段提示词，就能复制一个产品。

但放到 Coding Agent 里看，System Prompt 其实更像一份运行时说明书。

模型不是孤零零地坐在那里回答问题，它被放进了一个 Harness 里：有文件系统，有 shell，有编辑工具，有上下文，有权限边界，有任务循环，有日志和状态。System Prompt 做的事情，是把这些运行时能力翻译成模型能理解的操作契约。

也就是说：

```text
Harness 决定 Agent 真实能做什么；
System Prompt 决定模型以为自己应该怎么做。
```

这两者不一样。

一个工具即使暴露给模型，如果 prompt 没有解释清楚什么时候用、怎么用、风险是什么，模型也很容易用错。反过来，prompt 写得再漂亮，如果 harness 代码层没有真正实现权限、沙箱、文件编辑、命令执行和错误恢复，它也只是纸面规则。

所以看 System Prompt 的价值，不是为了复刻某家 Agent，而是为了反推它的 Harness 设计哲学。

## 先定义一下 Agent Harness

我理解的 Agent Harness，不是单个 prompt，也不是单个工具调用接口，而是把模型变成可执行 Agent 的整套外骨骼。

粗略拆开，大概包括这些东西：

```text
模型调用
+ 消息组织
+ System / Developer Prompt
+ 工具定义
+ 工具执行器
+ 文件系统和 shell
+ 上下文管理
+ 权限和审批
+ 任务状态
+ 日志和 trace
+ 失败恢复
```

最小版本其实很简单。一个 while loop，不断让模型思考、调用工具、拿到结果、继续下一轮，直到模型返回最终答案。

真正复杂的是循环外面的东西：哪些工具能用，工具结果怎么塞回上下文，命令能不能执行危险操作，文件编辑怎么避免误伤，任务太长怎么压缩上下文，用户中途打断怎么恢复。

这也是为什么我想从 Pi、Codex、Claude Code 三个样本开始看。它们不是简单的大中小，而是三种不同的 Harness 密度。

## 三个样本

这里用的是 Phistory 当前抓到的 latest 快照：

| Agent | 最新版本 | Prompt 规模 | 工具数 | 主要结构 |
| --- | --- | ---: | ---: | --- |
| Pi | `0.79.3` | 约 156 行 | 4 | System Prompt + User Message + Tools |
| Codex CLI | `0.139.0` | 约 652 行 | 15 | System Prompt + Developer Prompt + User Message + Tools |
| Claude Code | `2.1.177` | 约 1995 行 | 28 | System Prompt + User Message + Tools |

这里的 `User Message` 不是实际用户任务，而是 Phistory 为了触发 CLI 发起一次模型请求而传入的探针，大致是让 Agent 用一句短话回复。真正值得看的，是 System Prompt、Developer Prompt 和 Tools。

## Pi：最小执行闭环

Pi 最新快照里，prompt 只有一百多行，工具也只有四个：

```text
bash
edit
read
write
```

这很干净，也很有启发。

它说明一个 Coding Agent 的最低可用形态其实不复杂：能读文件，能写文件，能改文件，能跑命令，就已经形成了基本闭环。

很多时候我们把 Agent 想得太复杂，一上来就想要 memory、workflow、subagent、browser、scheduler、workspace、MCP。可是如果回到最小模型，coding agent 最核心的能力就是：

```text
看见当前代码
修改当前代码
运行验证命令
根据结果继续修改
```

Pi 的 prompt 短，不代表它没有 Harness。它当然还有 CLI、模型调用、工具执行、工作目录、消息循环这些代码。只是它暴露给模型的策略层很薄。

这种设计的好处是低成本、低噪音、自由度高。坏处也很明显：很多工程纪律没有显式写进去。

比如什么时候该先读代码，什么时候不要改用户没提到的文件，怎么保护未提交改动，测试失败怎么汇报，git 操作有什么边界。这些事情 Pi 不是完全不能做，而是更依赖模型自己泛化。

所以 Pi 更像一个 baseline：

> 如果你想自己写 Agent Harness，可以先实现一个 Pi-like 版本。等你发现四个工具也会引出权限、上下文、编辑安全、命令风险和终止条件这些问题，就会理解为什么更成熟的 Agent 会变复杂。

## Codex：工程协作协议

Codex 的 prompt 明显是另一种路线。

它的工具数量不算夸张，但 Developer Prompt 很重。它不只是告诉模型可以调用什么工具，更重要的是规定模型应该怎么像一个可靠的软件工程师一样工作。

比如它会强调先读代码，遵循现有风格，保护用户改动，不做无关重构，根据风险决定测试范围，最终回复要交代做了什么和有没有验证。前端任务里，还会要求真实检查 UI，而不是写完代码就结束。

这类规则看起来不像“能力”，但非常关键。

因为真实软件工程里，很多失败不是模型不会写代码，而是它太会写了：顺手重构、顺手改范围、顺手装依赖、顺手覆盖文件、顺手把一个小问题扩大成架构调整。

Codex 的 System/Developer Prompt 做的事情，是把模型的执行力压进工程协作边界里。

我会把它理解成：

```text
Pi 给模型工具；
Codex 给模型工作习惯。
```

这很像你带一个新人进项目。你不会只告诉他“这里有终端、编辑器、测试命令”，还会告诉他这个仓库怎么改、哪些地方不能碰、提交前怎么验证、遇到不确定需求什么时候问。

Codex 的价值就在这里。它不是最重的 Harness，但它很重视工程纪律。

## Claude Code：工作流运行时

Claude Code 又是第三种形态。

它的 prompt 更像一份完整运行时手册。除了读写文件和 shell，它还暴露了更多高阶能力：子 Agent、计划模式、任务系统、Workflow、Cron、Monitor、Worktree、WebSearch、NotebookEdit、PushNotification 等。

这已经不是“模型能不能改代码”的问题，而是“模型如何操作一整套工程工作台”。

Claude Code 需要更长的 prompt，因为它要解释的不只是工具参数，还有每个工具的使用场景、边界和风险。什么时候开子 Agent，什么时候进入 Plan Mode，什么时候用 Worktree 隔离，什么时候创建任务，什么时候该通知用户，什么时候不该用某个工具。

这类 Harness 的目标不是完成一个简单修改，而是接住更长、更复杂、更有状态的任务。

所以 Claude Code 的路线可以概括成：

```text
不是让模型直接干活，而是让模型调度一个工作系统。
```

这也是它和 Codex 的微妙区别。

Codex 更像一个工程师坐在你旁边，认真做当前任务。

Claude Code 更像一个工程工作台，里面有任务、子代理、计划、工作区、网页、定时器和通知。

前者强调工程协作质量，后者强调运行时能力编排。

## 三者真正的差异

如果只看 prompt 行数，很容易得出一个粗糙结论：Claude Code 最复杂，Codex 居中，Pi 最简单。

但我觉得更准确的对比是：

```text
Pi          最小执行闭环      能做事
Codex       工程协作协议      做得稳
Claude Code 工作流运行时      做得长、做得复杂
```

这三种不是强弱关系，而是复杂性放置方式不同。

Pi 把更多判断交给模型。

Codex 把工程纪律写进 prompt。

Claude Code 把大量运行时能力暴露给模型，并用 prompt 说明如何调度。

这背后其实是 Harness 设计里最核心的问题：

> 哪些复杂性应该放在模型里，哪些应该写进 System Prompt，哪些必须由 Harness 代码强制执行？

比如“不删除用户文件”这种规则，写在 prompt 里有用，但最好还要有工具层保护。

比如“先读代码再改”，更适合写进 prompt，作为行为习惯。

比如“命令超时”和“沙箱隔离”，就不应该靠模型自觉，必须由 Harness 实现。

比如“任务进度”，可以放在模型上下文里，也可以外化成 todo/task runtime。

System Prompt 的研究价值就在这里。

它让我们看到一个 Agent 产品把哪些规则交给模型遵守，哪些能力交给工具暴露，哪些边界可能藏在运行时代码里。

## 回到 Harness

所以这篇开篇想先建立一个观察方式：

不要把 System Prompt 当成咒语看，要把它当成 Harness 的接口层看。

看 Pi，可以知道一个 Agent 的最低形态。

看 Codex，可以知道工程纪律如何塑造模型行为。

看 Claude Code，可以知道完整工作流系统如何暴露给模型。

后面继续拆 Harness，我会更想看这些问题：

```text
Tool Calling 应该怎么设计？
bash 权限应该怎么收？
edit 工具用 patch、replace 还是 AST？
上下文应该怎么分层和压缩？
Plan、Todo、Task 应该放在 prompt 里还是 runtime 里？
Agent 怎么知道什么时候停？
trace 和 replay 怎么帮助调试失败？
Subagent 什么时候有用，什么时候只是增加协调成本？
```

如果最终要自己写一个 Agent Harness，我会从 Pi-like 的最小闭环开始，而不是一上来复制 Claude Code。

先实现 `read/write/edit/bash`。

然后加工程纪律。

再加上下文管理。

再加权限、日志、任务状态和恢复机制。

最后再考虑 workflow、subagent 和长期运行。

这条路看起来慢，但更容易看清每一层复杂性是为什么长出来的。

System Prompt 不是终点，只是入口。

真正要研究的，是它背后的 Harness。

## 参考

- [Phistory](https://phistory.cc/)
- [Phistory GitHub](https://github.com/WEIFENG2333/phistory)
- [Claude Code 2.1.177 prompt](https://github.com/WEIFENG2333/phistory/blob/main/captures/claude-code/2.1.177/prompt.md)
- [Codex CLI 0.139.0 prompt](https://github.com/WEIFENG2333/phistory/blob/main/captures/codex/0.139.0/prompt.md)
- [Pi 0.79.3 prompt](https://github.com/WEIFENG2333/phistory/blob/main/captures/pi/0.79.3/prompt.md)
