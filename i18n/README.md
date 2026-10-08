# t3code-zh i18n

这是 fork 的构建时字典转换层，覆盖 web、desktop renderer 和 desktop 主进程，不改变上游业务组件的每条文案。英文原文是 key，`zh-CN.json` 是按 key 排序的扁平词典。未知 key 保持原样，`ignore.json` 中有原因的 key 在自动改写时保持英文（显式位置覆盖除外）。没有新依赖，构建工具复用 web 已安装的 Babel。

web 在现有 Babel / React Compiler 管线中先运行 `plugin.mjs`，自动注入 `__t` / `__tf` import；desktop 的主进程 `vp pack` 使用同一个插件。`rules.mjs` 同时供转换器和提取器调用。`VITEST` 环境或 web 的 `mode: "test"` 禁用转换，上游测试仍使用英文。

运行时同步读取当前 origin 的 `localStorage["t3zh.locale"]`，默认 `zh-CN`，英文为 `en`。启动入口先加载运行时，设置 `<html lang>`，再加载应用。Map 查表不请求服务器、不观察 DOM；每次查表不再访问 storage。Settings → Appearance → Interface → **Language / 语言** 可在 English / 简体中文之间切换，先保存再刷新页面。语言属于当前客户端，不随项目、服务器或远程连接切换。

desktop 通过现有 bridge / IPC 保存同一选项。主进程在启动求值前读取 Electron `appData/t3code-zh/locale.json`（dev 使用 `locale-dev.json`），缺失或无效时默认中文。renderer 刷新立即生效，所有主进程文案与 Chromium role 菜单在**下次启动应用**时统一生效；不强制重启正在运行的 agent。macOS 的部分系统菜单仍由系统管理，需在最终 DMG 上验收。可用绝对路径环境变量 `T3ZH_LOCALE_FILE` 隔离原生验证数据；没有读写 T3 的业务数据库。Electron 打包保留 `en-US` 和 `zh-CN` locale 资源。

## 候选规则

- JSX 文本按 React 的换行/缩进语义整理，保留同一行有意义的空格。key trim 后查表，运行时拼回原首尾空白。
- JSX 文案属性与文案对象属性由 `uiProperties` 集中维护，包括 camelCase 的 ariaLabel/accessibilityLabel、tooltipText、disabledReason、各类按钮标签等。直接 JSX 表达式与三元/`??`/`||` 分支也入选。`*Label` 等文案变量/函数返回值、`*_LABEL_BY_*` 等标签表，以及 `labels`/dialog `buttons` 数组支持单词文案；JSX 的 headers/steps 数组可译，HTTP headers 保持原值。
- inputProps、permissions、presentation、size 等复合 prop 只开放内部独立识别的文案字段；直接 size/value、id 等仍受保护。事件回调中支持 toast 文案对象、confirm/alert/Notification、错误消息 setter、经过核对的本地提示包装器和 clipboard API 的提示参数。name 默认不开放，仅识别文件筛选器、媒体预览、内置浏览器 profile、脚本显示名等已审核结构；这些结构中的 id、文件扩展名、URL 不翻译。
- 任意位置包含空格分隔的至少两个英文字词的字面量入选；这会包括部分错误、命令或内部文本，**候选不是自动批准的译文**。模板的每个表达式按序成为 `{0}`、`{1}`；译文可重排或省略，嵌套片段先从内向外改写，表达式仍按原顺序求值、转换成字符串一次。转换前固定原 AST 的分类结果，避免改写局部 helper 后使调用点漏译。含字面 `{数字}` 的模板有歧义，进入复核清单。
- 保护规则优先于词典：import/export、TS 类型/enum、对象 key、比较与 `in`、case、字符串匹配/替换调用、Schema/Literal、日志调用、非文案属性、import.meta/URL、tagged template、注入脚本参数等保持原样。`searchTerms` 保留英文；Settings 搜索额外查询当前语言的 title、分区名和有词典条目的别名，英文关键词仍可匹配。
- 完整内联 HTML 由共享规则提取正文、title/alt/aria 等引号属性，以及脚本中直接赋给 textContent 的字面量 fallback；不再把整页源码作为 key。自动注入的 __th 对译文按 HTML 或 JS 字符串上下文转义，CSS/脚本/URL 保留，英文输出保持原文；中文页面设置 html lang。此扫描器只支持仓内已核对的完整文档，不是任意 HTML/JS 解析或净化工具。
- 两参数局部 plural(count, noun) helper 只在符合已审核的插值/后缀结构时开放 noun 参数与 s 后缀。空串译文有效；秒单位位置仍受保护。formatRelativeTime/Until 的 value/suffix 是呈现字段；Sidebar 按 suffix 是否为空判断刚刚，不再比较英文。
- 扫描 web 与 desktop 的 `src` 及 client-runtime/contracts/shared 的源码；测试、声明、生成文件、desktop sandbox preload、独立 worker、boot/compileCache 不在转换范围。嵌套模板片段继承外层 UI/自然语言上下文与所有保护条件；不直接翻译变量、用户内容或协议值。mobile、marketing、server、依赖不在扫描范围。服务端提供的已知 UI 选项标签只在下述显示入口查表，agent 文本与用户内容保持原样。

## 位置覆盖与动态显示

`zh-CN.context.json` 按仓库相对文件路径组织：`{"apps/web/src/Example.tsx": {"Share": "占比"}}`。同文件有歧义时可用 `"Clear::line=211": "清透"`；精确行优先于文件覆盖，再回退全局词典。插件把译文作为 `__t(raw, override)` / `__tf(raw, args, override)` 的额外参数内联，HTML 片段同理；英文模式仍返回原文，不新增运行时词典加载。覆盖只作用于规则已允许的 UI 位置，不能绕过比较、协议值等保护。测试检查全部覆盖仍能命中生产源码，并分别验证 DeviceToolsPanel 的清透外观与清除位置按钮；上游 merge 移动行号后须重新核对。

`display.js` 用于少量动态显示边界：TraitsPicker 与 provider 设置表单的标签/描述、Git 操作菜单、线程标题、相对时间和用量限额。先完成原始值的比较、选择与图标判断，再调用 `displayLabel`；不映射 descriptor、option ID、持久化数据或回传值。`displayThreadTitle` 只翻译完全等于 `New thread` 的服务端种子，重命名输入和提交继续使用原始标题。`relativeTimeSuffix` / `joinRelativeTime` 在中文去掉 value 与后缀间的空格，英文保留。用量 helper 只翻译已知提示后缀和周期标签，保留环境名、账号名、模型后缀及未知错误原文；服务端数据与归并键仍用原值。上述 helper 与 Babel 一样在测试模式保持英文；i18n 专项测试显式启用 production 模式。

`display-labels.json` 是从 provider 源码核对的动态标签清单，附显示文件与来源；提取器将这些运行时查表入口也纳入覆盖率。新 provider 增加已知标签时需同步清单，未知/自定义标签仍回退原文。Commit/Push 等同时是语义值和显示文字：可以同时存在于 ignore 与全局词典，ignore 保持自动改写和图标比较所需的英文，显式显示 helper 从词典取中文；不要仅为显示翻译移除 ignore。

## 补词典与覆盖账本

使用 Node 24，以下命令从仓库根运行。临时输出目录需事先创建；本仓任务按任务书设置 `TMPDIR/TMP/TEMP`。

```sh
node i18n/coverage.ts \
  --candidates /absolute/task-dir/candidates.json \
  --review /absolute/task-dir/review.json \
  --missing /absolute/task-dir/missing.json
vp test run i18n/
```

`candidates.json` 是完整唯一 key 数组，包含占位表达式、上下文类别、最多 8 个位置和出现次数；desktop 条目另有原始 UI context。位置覆盖按全部出现次数计数，部分位置有覆盖不会掩盖其他位置缺译；动态显示条目带 `displayOnlyOccurrences` 和 `:display-label` 来源标记，不能仅靠 ignore 满足查表需求。stderr 输出候选总数/已翻译/已忽略/缺失及分类数（一个 key 可属于多个类别，分类数不相加为总数）。`review.json` 列出疑似 UI 但被规则保护或尚不支持的位置和原因，不计分母；每项 reasons 与 stderr 的 reviewByReason 统计所有出现位置，不受 8 个示例上限影响。未指定 `--missing` 时缺失数组写 stdout，未指定 `--review` 时复核数组写 stderr；默认不创建任何文件。缺失大于零退出 1，全覆盖退出 0，参数/解析错误退出非零。

可重复传 `--scope <范围内文件或目录>` 做局部核对，`--dictionary <JSON>` / `--ignore <JSON>` 用于隔离验证，均不改正式词典。测试通过同一 CLI 先跑缺失字典，再跑完整的小范围字典，验证两个退出码。

翻译时先看同 key 的多处上下文，再加到 `zh-CN.json` 并按 key 排序。品牌、模型、快捷键和协议值在 `ignore.json` 记录 `category` / `reason`。只有部分位置必须保持英文时，放进 `protected-locations.json`（文件、key、原因，可选精确 line），并补规则测试；它们仍出现在复核清单。保护位置测试会检查生产源码，合并后位置移动或消失必须重新核对。Browser/Branch 标签、Mixed/Unavailable 占位符、自定义模型 Fast、主题 token 映射等不可仅凭英文外观认作文案。不要在业务组件中逐条包 `t()`。词典 key 或规则变化后需重新构建/重启自己的 dev 实例，因为字典决定哪些位置在构建时改写。

同步上游的流程是 **merge → coverage → 审查新候选与复核项/位置覆盖/动态标签清单 → 补词典/ignore → focused tests → web 与 desktop 构建 → 更新说明**。 打包用 `npm run dist:desktop:dmg:arm64:zh`，版本号自动取所基于的上游 nightly；构建时调用上游版本盖章脚本，结束后恢复包清单。推送后用 `node scripts/release-desktop-zh.mjs` 把本地 DMG 发成 fork 的 GitHub Release（tag `zh-v<版本>`，正文取同步合并提交里的更新说明；先加 `--dry-run` 看一遍），发布成功后本地安装包可删，回滚从旧 Release 下载。更新说明从 `git log --no-merges <旧基线>..<目标 tag>` 整理用户能感知的新功能、行为变化和重要修复，按桌面/网页、移动端（需另装商店版才有）、服务端与 Agent 分组，写进合并提交正文并在交付时告诉用户；纯 CI、依赖、测试类提交不列。范围不等于全程序数据流证明：常量可能被导出后与服务端英文值比较，标签也可能兼作状态。已发现的线程标题种子按位置保护；Commit/Push 的禁用状态图标仍比较原始标签，连同进度 sentinel、旧上下文分隔符按 key 保留。只有解除语义依赖后才由词典 owner 移除 ignore；词条失去候选位置时也应清理整页 HTML 等旧 key。新词典批次仍需查引用；拆分 JSX 与拼接句子也可能需要后续规则扩展。覆盖率 100% 只表示当前规则内每个 key 有翻译或明确忽略，不表示整个产品已完成中文化或真实客户端验收。
