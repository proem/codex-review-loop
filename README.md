<h1 align="center">codex-review-loop</h1>

中文 | [English](README.en.md)

> 🔁 盯住 Codex review，修完该修的，在该停的地方停下

<!-- Once skills.sh indexes this repo (https://www.skills.sh/proem/codex-review-loop returns 200), swap the static badge for the live install count: <img src="https://skills.sh/b/proem/codex-review-loop?v=2"> -->
<p align="center">
<a href="https://skills.sh/proem/codex-review-loop"><img src="https://img.shields.io/badge/skills.sh-npx%20skills%20add-black?style=flat-square" alt="skills.sh 安装"></a>
<a href="LICENSE"><img src="https://img.shields.io/github/license/proem/codex-review-loop?style=flat-square" alt="MIT 许可证"></a>
</p>

盯住一个 GitHub PR 上的 Codex AI review，边跑边修每一条发现，并在合适的时机停下（Codex 给出 👍，或者你判断已经到了严重度下限），而不是无止境地追着 nitpick 跑。

<p align="center">
<img src="docs/images/01-the-loop.png" alt="追着 AI review 的 nitpick 永远修不完，纸条首尾相连绕成一个环" width="720">
</p>

## 这是什么

`codex-review-loop` 是一个 [Claude Code](https://claude.com/claude-code) skill（同时通过 `.codex-plugin/plugin.json` 打包为 Codex 插件），负责陪一个 pull request 走完 [OpenAI Codex](https://openai.com/index/introducing-codex/) 的 GitHub review bot（`chatgpt-codex-connector[bot]`）全程：监控新的 review 动态、为每条发现写修复、解决对应的 thread，并且自己判断——而不是让 bot 判断——PR 什么时候算完。

## 为什么

Codex 总能再挑出一条 nitpick，而且它在 push 之后的自动 review 并不可靠（经常在一个新 commit 上完全没有任何反应）。放任不管的话，要么变成一个永远追着 👍 跑不完的无限 review 循环，要么变成一个因为没人注意到 bot 沉默了而静静卡住的 PR。这个 skill 用机制化的方式把这两个坑都堵上了。

## 核心设计

- **自愈式 monitor** —— 每个轮询周期只发一条 GraphQL 查询，同时盯住 review、行内发现、PR 上的 issue 评论、👍 reaction 和 CI。如果 head commit 已经 CI 变绿但 Codex 还没有任何反应，monitor 会对每个未被 review 的 head 自动发一条 `@codex review` —— 不需要人去发现这个卡点。

  <p align="center">
  <img src="docs/images/02-self-healing-monitor.png" alt="CI 已变绿但 Codex 沉默不语，monitor 主动戳一下而不是干等" width="640">
  </p>

- **配额感知的自动退出** —— 如果 Codex 回复的是一条明确的用量/配额限制消息而不是 review，monitor 会机制化地识别出来，打印 `[BLOCKED:QUOTA]`，然后自己退出监控，而不是把这个事实埋在日常轮询输出里。

  <p align="center">
  <img src="docs/images/05-quota-block.png" alt="Codex 报出额度用完，monitor 立刻停表并上报，而不是傻等" width="640">
  </p>

- **停止的决定权在你手里，不在 bot 手里。** 三个合法的退出条件，任意一个满足就可以结束循环：
  1. Codex 给出 👍 —— 最干净的方式。
  2. 你判断已经到了严重度下限（没有未解决的 P0、改动路径上没有未解决的 P1、也没有你引入的 regression）—— 剩下的都归档为后续 issue。
  3. 轮次上限，作为兜底，防止 Codex 无限重复提同样的 nitpick。

  <p align="center">
  <img src="docs/images/03-three-exits.png" alt="停止的决定权在人手里，三扇门是三个合法的退出条件" width="640">
  </p>

- **P0–P3 决策表**：决定哪些要在这个 PR 里直接修，哪些归档为后续 follow-up。

  <p align="center">
  <img src="docs/images/04-triage.png" alt="把评审发现分诊为现在修还是记下来以后再说" width="640">
  </p>

- **合并是可选项，且有安全闸门** —— 循环本身从不自动合并；只有在明确带着合并意图启动的情况下才会合并，并且要求 CI 全绿、且没有未解决的 P0 或改动路径上的 P1。

## 依赖要求

- [`gh`](https://cli.github.com/)（GitHub CLI），并已针对目标仓库完成认证。
- `jq`。
- 目标仓库已安装 [Codex GitHub 连接器](https://developers.openai.com/codex)，这样 `chatgpt-codex-connector[bot]` 才会真的去 review PR。

## 安装

推荐用 [`skills`](https://www.npmjs.com/package/skills) CLI 一键安装——一条命令，自动适配 Claude Code、Cursor、Codex 等主流 agent：

```bash
npx skills add proem/codex-review-loop
```

也可以手动安装：clone 本仓库，然后把 `skills/codex-review-loop/` 目录复制到你的 skills 目录下——个人级安装放到 `~/.claude/skills/`，项目级安装放到项目内的 `.claude/skills/`。

**Codex**：本仓库在 `.codex-plugin/plugin.json` 提供了 Codex 插件清单，因此也可以作为 Codex 插件安装。

重启 Claude Code 会话即可生效。

## 使用方法

装好之后，在你想让 Codex 把关的一个开着的 PR 上触发它——比如说“watch codex on this PR”或者“盯着 codex 的 review”。完整的协议、决策规则、monitor 脚本和修复流程都在 [`skills/codex-review-loop/SKILL.md`](skills/codex-review-loop/SKILL.md) 里。

## 许可证

[MIT](LICENSE)
