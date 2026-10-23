# opencode-guard

[English](README.md) | 简体中文

一个 OpenCode 2 插件（macOS，OpenCode 2.0.32 或更新）：把 OpenCode 的 shell 命令放进 Claude Code 自己的沙箱（[sandbox-runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime)）里跑。沙箱按插件自己配置文件的 `sandbox` 段配置，写法与 Claude Code 设置里的 `sandbox` 段相同；插件从不读 Claude 的设置。沙箱管不到的事交给 OpenCode 自己的 `permissions`，由它弹卡片询问。这些由互不相关的两个模块做：沙箱（`src/sandbox`，下面前两条）和自动审查（`src/autoreview`，第三条），`src/index.ts` 把它们接在一起。

- **沙箱**：每条 shell 命令（模型的与用户的）都由 sandbox-runtime 按 `sandbox` 段包好再跑，每条命令都重读一遍配置；另把会话目录设为可写，会话目录里 OpenCode 的项目配置（`.opencode/`、`opencode.json`、`opencode.jsonc`）设为只读：写在那里的项目插件会在之后的会话里运行，能换掉沙箱。Claude Code 自己的沙箱在设置之外另加的保护也照加：会话目录以及它往上直到家目录的每一层里 Claude 的配置（`.claude/settings.json`、`.claude/skills`、`.claude/hooks`、`.mcp.json` 等）和 `~/.claude` 下的状态只读，那里的凭据（`~/.claude/ide`、`seed-admin`、`bridge-spawn`）不能读；git 钩子与配置、shell 启动文件等和 Claude Code 一样只读。`network` 段里不写 `allowedDomains` 时网络不受限：不走代理，一切连接（含 SSH 与其他裸 TCP）都放行。写了它，网络就走 sandbox-runtime 的代理：`deniedDomains` 照挡，其余放行，不认代理的连接连不上。插件把 shell 换成随插件提供的脚本 `bin/sandboxed-shell`，它执行经环境变量传来的、包好的命令，所以命令原文不动：OpenCode 起命令固定是 `[shell, "-c", command]`，它自己的许可判定、后台命令的标题、发给代理的通知显示的都是这条命令。沙箱建不起来（没有 `sandbox` 段、设置无效）时，命令被拒绝执行。
- **出沙箱**：为了跑被沙箱挡下的命令，shell 工具多了两个参数 `unsandboxed` 与 `explanation`，跟 Claude Code 的 Bash 有 `dangerouslyDisableSandbox` 一样。沙箱放行什么、什么时候出沙箱，写在 `unsandboxed` 字段自己的说明里：OpenCode 每次请求都重设 shell 工具的说明，加在那里的字到不了代理。插件用 `mapFields` 把它们加进工具的 Effect 参数格式，两个字段由原有字段改说明得来，与 OpenCode 用的是同一份 Effect；参数格式认不出时原样不动，代理也就出不了沙箱。OpenCode 先把代理给的原始入参交给 `execute.before` 钩子、再解码，插件在那里把两个字段取走，shell 工具本身看不到它们。带 `unsandboxed: true` 时代理必须给一段说明：用用户的语言写一两句话，讲清命令做什么、为什么要出沙箱、在沙箱外写或删什么、连什么、起停什么，或者说明它只读；没有说明就不问用户、不运行，调用报错并说明原因。插件在这里发询问，而不靠 shell 自己的许可判定：shell 拆不出子命令时不做判定。询问照 OpenCode 自己的 shell 那样发：动作是 `shell`，资源是用 OpenCode 自己的解析器拆开的各段（`@opencode/core` 的 `ShellParse.scan`，版本钉成 OpenCode 的，第一次用时才载入；拆不出或解析失败时整条命令算一段，这种情况 OpenCode 自己不问），这次调用的入参（`command`、代理给了的 `workdir`、`unsandboxed: true`）放在 `metadata.input` 里，供审查用。插件的许可钩子把说明原样写进卡片顶上的 message。不论规则对 `shell` 怎么写，一律问：只有规则拒绝这条命令时照样拒绝，会话级的规则也跳不过这一问。谁来回答不归沙箱管：OpenCode 的卡片，或者开着的自动审查。请求不带 `save`，所以卡片没有“始终允许”。被规则拒绝、或用户附了话再拒绝，这次调用就带着那句话报错；用户直接拒绝时，调用带着 OpenCode 自己的错误失败，代理这一步停下，跟 OpenCode 自己的卡片一样。允许之后它就是一次普通的 shell 调用：前台跑，或带 `background` 在后台跑、列进 OpenCode 的后台命令、结束时通知代理；打断会话会结束它。OpenCode 的 shell 钩子只看得到命令和目录，看不到来自哪次调用，所以插件在命令上方加一行带一次性随机令牌的注释；钩子只在令牌是插件发出、还没用过时才不套沙箱运行，并先去掉这一行，所以 OpenCode 运行、列出、报告的都是不带这一行的命令。令牌本身就是通行证、不认命令：同一次调用里排在后面的插件钩子（`execute.before`）可能改写这一行下面的命令（RTK 把 `ls` 改成 `rtk ls`），而令牌只出现在这次调用的入参里。会话里记的是代理发来的原样调用。令牌只能用一次；别的带这种行的命令（伪造的、重放的）都带着这一行在沙箱里跑。发出的令牌记在进程里，不记在插件的某一次加载里：OpenCode 会在调用途中热重载插件，旧加载发的令牌由新加载的 shell 钩子来收。
- **自动审查**：开着时，接管所有本来要弹卡片的许可请求，沙箱出沙箱的也算；关着时全部交给 OpenCode。每个请求先由一个模型审一遍，用一次 `generate.text` 调用，所以 OpenCode 列出的模型都能用，包括 `claude-code/…`。它是简化版的 Claude Code 本机自动模式分类器：模型判代理最新这一个动作要不要拦下，只按用户的规则（`policy`），不带 Claude 那套默认规则表。给模型的有：`AGENTS.md`（只有对同一操作、同一目标的明确授权才算）；工作目录与家目录；照 Claude 的写法排的会话记录：每行一条 JSON，用户的消息（连同贴进来的文字）、用户对代理提问的回答（点的选项连同它的说明）、用户直接跑的命令全文保留，代理说的话，每次不是查找的工具调用连同它怎么结束的（`ok`、`error`、`interrupted`、`rejected-by-user`）、不带输出，OpenCode 的压缩作为代理写的摘要，最后一行是要判的动作。子代理的会话里，父代理写的任务算用户消息，和 Claude 一样。跟 Claude 的分类器不同、照 Cursor 那样，模型答之前可以先看本机文件：它回几行 `<read path="tool.sh"/>`（长文件可加 `offset`、`limit` 读一段）或 `<list path="."/>`，一次最多五个，插件替它读、把结果接在后面再问一次，每个结果截到约 2,000 token，并标明是文件内容、不是用户的话；最多三轮，还在看就交给用户。路径从会话目录算起，先解开链接；沙箱不让读的（`denyRead`、Claude 的凭据）和二进制文件不读：读到的会发给审查模型的提供方。非用户的行各截到约 1,000 token，从最新往前在约 20,000 token 内保留。提示词讲清会话记录怎么读、什么算用户同意（用户自己的消息点名了动作与目标，或代理紧挨着提出、用户回了“好”的那一个下一步）。模型回答 `<block>yes</block><reason>…</reason>` 或 `<block>no</block>`，只有明确的 `no` 放行；被它放行的调用，输出第一行是 `已自动放行`。其余情况（包括出错、60 秒内没答），都由插件代替 OpenCode 发一张卡片问用户：动作、资源与详情都一样，只是不带 `save`，所以卡片没有“始终允许”（改文件时 OpenCode 会存下 `*`，以后项目里改哪都既不问也不审）。审查的理由在卡片说明后另起一行，写成 `⚠ 自动审查：<理由>`。许可钩子去不掉 OpenCode 卡片上的 `save`，所以由钩子另发一张、等用户答，再按回答定原请求：允许一次就放行；附了话再拒绝就拒绝，那句话交回代理；直接拒绝则带着 OpenCode 自己的错误失败，代理这一步停下。卡片详情里的键 `opencode-guard.stand-in` 标明这是插件自己发的，所以不会再审一遍。
- **语言**：插件自己给用户看的字（`⚠ 自动审查：`、`已自动放行`）有英文与中文两套（英文是 `⚠ Auto review:`、`Auto-approved`），按插件运行的环境选：看语言区域变量 `LC_ALL`、`LC_MESSAGES`、`LANG`；它们没设，或只是 `C`、`POSIX`（OpenCode 的服务常是这样）时，看 macOS 的首选语言；都不行就用英文。代理和审查模型写的内容跟着聊天的语言：工具要求代理用用户的语言写说明，审查者用用户消息的语言写理由。只给模型看的文字（工具说明、交回代理的话、沙箱的报错）保持英文。

## 文件

| 路径 | 内容 |
|---|---|
| `~/.config/opencode/opencode-guard.json` | `sandbox`：写法同 Claude Code 的设置。`autoReview`（可选）：见下 |

可写的工作区只有会话自己的目录，不是 OpenCode 的项目目录：后者是所在 git 仓库的根，可能大得多。

在 OpenCode 的插件目录里放一个目录来加载插件：`~/.config/opencode/plugins/opencode-guard/`，里面两个一行的转发文件，`index.ts` 给服务端，`tui.tsx` 给终端界面。

```js
// index.ts
export { default } from "/Users/<你>/code/opencode-guard/src/index.ts"
// tui.tsx
export { default } from "/Users/<你>/code/opencode-guard/src/tui.tsx"
```

OpenCode 终端界面的 shell 许可卡片只显示命令、不显示请求的 message，所以终端那一半（`src/tui.tsx`）把代理出沙箱的说明画在卡片正上方，用卡片自己的底色与左边框，请求答完就消失。OpenChamber 自己会显示 message。

`autoReview` 每次请求都整段重读，改了立刻生效；关着时请求照 OpenCode 原样弹卡片；开着却用不了时，本来要弹卡片的请求不经审查，直接由插件发卡片问：

```json
"autoReview": {
  "enabled": true,
  "model": "magpie/claude/claude-haiku-5-5",
  "policy": ["## The user's write scope", "1. …", "…"]
}
```

`model` 是 `<provider>/<模型 ID>`，照 OpenCode 列出的写。`variant` 可选，是该模型的一个变体（如 `"high"`），跟 OpenCode 自己 agent 配置里 `model` 旁的 `variant` 一样；不写就用模型默认。`policy` 是用户的规则，一行一个字符串：规则放行的，审查者放行，其余交给用户。

配套的许可规则（`opencode.json` 的 `permissions`），只让沙箱管不到的事弹卡片：先全部放行，再让会话目录以外的改动（OpenCode 给这类改动的是绝对路径）询问。出沙箱的命令不用规则，一律询问：

```json
[
  { "action": "*", "resource": "*", "effect": "allow" },
  { "action": "edit", "resource": "/*", "effect": "ask" }
]
```

## 测试

`bun test` 跑单元测试；跑真实沙箱的那几个在另一层 Seatbelt 沙箱里会跳过，因为 Seatbelt 不能嵌套。端到端的检查同理，要在任何沙箱之外起 `opencode serve`。

卸载时删掉 `~/.config/opencode/opencode-guard.json`、插件目录与那几条许可规则。
