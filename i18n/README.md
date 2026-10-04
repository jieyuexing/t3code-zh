# t3code-zh i18n

这是 fork 的构建时字典转换层，覆盖 web、desktop renderer 和 desktop 主进程，不改变上游业务组件的每条文案。英文原文是 key，`zh-CN.json` 是按 key 排序的扁平词典；目前只包含演示译文。未知 key 保持原样，`ignore.json` 中有原因的 key 优先保持英文。没有新依赖，构建工具复用 web 已安装的 Babel。

web 在现有 Babel / React Compiler 管线中先运行 `plugin.mjs`，自动注入 `__t` / `__tf` import；desktop 的主进程 `vp pack` 使用同一个插件。`rules.mjs` 同时供转换器和提取器调用。`VITEST` 环境或 web 的 `mode: "test"` 禁用转换，上游测试仍使用英文。

运行时同步读取当前 origin 的 `localStorage["t3zh.locale"]`，默认 `zh-CN`，英文为 `en`。启动入口先加载运行时，设置 `<html lang>`，再加载应用。Map 查表不请求服务器、不观察 DOM；每次查表不再访问 storage。Settings → Appearance → Interface → **Language / 语言** 可在 English / 简体中文之间切换，先保存再刷新页面。语言属于当前客户端，不随项目、服务器或远程连接切换。

desktop 通过现有 bridge / IPC 保存同一选项。主进程在启动求值前读取 Electron `appData/t3code-zh/locale.json`（dev 使用 `locale-dev.json`），缺失或无效时默认中文。renderer 刷新立即生效，所有主进程文案与 Chromium role 菜单在**下次启动应用**时统一生效；不强制重启正在运行的 agent。macOS 的部分系统菜单仍由系统管理，需在最终 DMG 上验收。可用绝对路径环境变量 `T3ZH_LOCALE_FILE` 隔离原生验证数据；没有读写 T3 的业务数据库。Electron 打包保留 `en-US` 和 `zh-CN` locale 资源。

## 候选规则

- JSX 文本按 React 的换行/缩进语义整理，保留同一行有意义的空格。key trim 后查表，运行时拼回原首尾空白。
- JSX 文案属性（title、placeholder、aria-label、aria-description、alt、label、description、tooltip、aria-valuetext 等）、直接 JSX 表达式与三元/`??`/`||` 分支、文案对象属性由 `uiProperties` 集中维护。单词只在这些位置入选。Electron dialog 的 `buttons` 数组也视为 UI。
- 任意位置包含空格分隔的至少两个英文字词的字面量入选；这会包括部分错误、命令或内部文本，**候选不是自动批准的译文**。模板的每个表达式按序成为 `{0}`、`{1}`；译文可重排或省略，表达式仍按原顺序求值、转换成字符串一次。含字面 `{数字}` 的模板有歧义，进入复核清单。
- 保护规则优先于词典：import/export、TS 类型/enum、对象 key、比较与 `in`、case、字符串匹配/替换调用、Schema/Literal、日志调用、非文案属性、import.meta/URL、tagged template、注入脚本参数等保持原样。`name`、`value`、`searchTerms` 默认保护；不把标识符或搜索别名当成显示文本。
- 扫描 web 与 desktop 的 `src` 及 client-runtime/contracts/shared 的源码；测试、声明、生成文件、desktop sandbox preload、独立 worker、boot/compileCache 不在转换范围。模板内的字符串片段由外层模板统一处理。mobile、marketing、server、依赖和服务端/agent 动态返回的文字不翻译。

## 补词典与覆盖账本

使用 Node 24，以下命令从仓库根运行。临时输出目录需事先创建；本仓任务按任务书设置 `TMPDIR/TMP/TEMP`。

```sh
node i18n/coverage.ts \
  --candidates /absolute/task-dir/candidates.json \
  --review /absolute/task-dir/review.json \
  --missing /absolute/task-dir/missing.json
vp test run i18n/
```

`candidates.json` 是完整唯一 key 数组，包含占位表达式、上下文类别、最多 8 个位置和出现次数；desktop 条目另有原始 UI context。stderr 输出候选总数/已翻译/已忽略/缺失及分类数（一个 key 可属于多个类别，分类数不相加为总数）。`review.json` 列出疑似 UI 但被规则保护或尚不支持的位置和原因，不计分母。未指定 `--missing` 时缺失数组写 stdout，未指定 `--review` 时复核数组写 stderr；默认不创建任何文件。缺失大于零退出 1，全覆盖退出 0，参数/解析错误退出非零。

可重复传 `--scope <范围内文件或目录>` 做局部核对，`--dictionary <JSON>` / `--ignore <JSON>` 用于隔离验证，均不改正式词典。测试通过同一 CLI 先跑缺失字典，再跑完整的小范围字典，验证两个退出码。

翻译时先看同 key 的多处上下文，再加到 `zh-CN.json` 并按 key 排序。品牌、模型、快捷键和协议值在 `ignore.json` 记录 `category` / `reason`。只有部分位置必须保持英文时，放进 `protected-locations.json`（文件、key、原因），并补规则测试；它们仍出现在复核清单。不要在业务组件中逐条包 `t()`。词典 key 或规则变化后需重新构建/重启自己的 dev 实例，因为字典决定哪些位置在构建时改写。

同步上游的流程是 **merge → coverage → 审查新候选与复核项 → 补词典/ignore → focused tests → web 与 desktop 构建**。范围不等于全程序数据流证明：常量可能被导出后与服务端英文值比较，标签也可能兼作状态。已发现的线程标题种子按位置保护；Commit/Push、进度 sentinel、旧上下文分隔符、just now 按 key 保留。新词典批次仍需查引用；拆分 JSX 与拼接句子也可能需要后续规则扩展。覆盖率 100% 只表示当前规则内每个 key 有翻译或明确忽略，不表示整个产品已完成中文化或真实客户端验收。
