# VanJS + Goober + Vanilla 库笔记

## 当前方向

现在的主线可以定为：

```txt
VanJS 管 DOM 和 state
goober 管 CSS class
vanilla/core 小库管单功能能力
localStorage 先做本地持久化
```

这个组合的优点是小、直接、容易看穿。不要一开始就上大框架、大 UI 库或复杂状态方案。

## VanJS 的动态模型

VanJS 的核心是：

```txt
state 变
-> 绑定函数重新执行
-> 更新对应 DOM/text/属性
```

常见写法：

```js
const draft = van.state("")

p(() => draft.val)
button({ class: () => active.val ? activeClass : normalClass })
```

普通 JS 逻辑里要用 `.val`：

```js
if (draft.val.trim()) {}
memos.val = [...memos.val, memo]
```

VanJS 支持少量简写：

```js
p(draft)
textarea({ value: draft })
```

这些是 VanJS 内部帮你绑定了 state，本质还是读 `draft.val`。

## 什么时候包 `() =>`

可以先用一个通用理解：

```txt
静态值：直接写
动态 DOM/text/属性：包函数
普通事件逻辑：不包，直接读写 .val
```

例子：

```js
h1("Memos")
p(() => draft.val)
button({ onclick: () => addMemo() }, "保存")
```

列表里要注意：

```js
() => section(
  memos.val.map(memo => article(memo.content))
)
```

绑定函数最好返回一个 DOM 节点或文本。不要直接返回 DOM 数组：

```js
// 不好，容易变成 [object HTMLElement]
() => memos.val.map(...)
```

## Goober 的定位

goober 是运行时 CSS-in-JS。它做的事：

```txt
css`...`
-> 解析 CSS
-> hash 成 className
-> 插入 <style id="_goober">
-> 返回 className
```

VanJS 里直接用：

```js
import { css, glob } from "goober"

glob`
  body {
    margin: 0;
  }
`

const card = css`
  padding: 12px;
  border: 1px solid #ddd;
`

article({ class: card }, ...)
```

`css` 适合组件样式，`glob` 适合全局样式。

## Goober 源码主线

本地仓库位置：

```txt
vanjs-projects/goober
```

入口：

```js
export { styled, setup } from './styled';
export { extractCss } from './core/update';
export { css, glob, keyframes } from './css';
```

主线：

```txt
css.js
-> compile.js / astish.js
-> hash.js
-> parse.js
-> update.js
-> get-sheet.js
```

关键点：

```txt
astish: CSS 字符串转成对象结构
parse: 对象结构转成带作用域 selector 的 CSS
toHash: 生成 go123456 这种 class
update: 写入 style 标签或 SSR 字符串缓存
extractCss: SSR 时取出 CSS 并清空缓存
```

`styled/setup` 更适合 React/Preact 的 vnode 模型。VanJS 里先不用。

## 动态样式分工

goober 不会自动监听 VanJS state。

这种只在执行 `css` 时取一次值：

```js
const card = css`
  opacity: ${draft.val ? 1 : 0.5};
`
```

推荐分工：

```txt
静态样式：goober css
有限状态：VanJS 动态 class
连续动态值：VanJS style 或 CSS variable
```

有限状态：

```js
const card = css`padding: 12px;`
const active = css`border-color: blue;`

article({
  class: () => [card, selected.val && active].filter(Boolean).join(" ")
})
```

连续值：

```js
const card = css`
  opacity: var(--opacity);
`

article({
  class: card,
  style: () => `--opacity: ${done.val ? 0.5 : 1}`
})
```

高频动画/拖拽不要每帧生成新的 goober class。

## Goober 性能

goober 性能取决于用法：

```txt
静态 css：很好
少量动态 css：可以
高频动态生成 class：不要
```

静态样式只执行一次：

```js
const card = css`...`
```

之后只是普通 class。

真正容易变大的通常不是 VanJS/goober，而是外部库，例如 Tippy、Sortable、Popper。

## 无构建路线

如果只有 VanJS + goober，可以不构建，直接浏览器 ESM：

```html
<script type="module">
  import van from "https://cdn.jsdelivr.net/npm/vanjs-core@1.6.0/src/van.min.js"
  import { css } from "https://cdn.jsdelivr.net/npm/goober@2.1.19/dist/goober.modern.js"
</script>
```

适合：

```txt
学习 demo
小工具
个人页面
少量依赖
```

需要构建的情况：

```txt
npm 管依赖
TypeScript
压缩打包
CSS Modules / vanilla-extract
资源处理
正式发布
```

## Vanilla 小库接 VanJS

很多现代库会分成：

```txt
core / vanilla / dom 层
React/Vue/Svelte adapter 层
```

优先找这些关键词：

```txt
vanilla
core
dom
headless
framework agnostic
web components
no dependencies
```

VanJS 接 vanilla 库的通用模式：

```js
const el = button(...)

queueMicrotask(() => {
  const instance = someLib(el, options)
})

return el
```

原则：

```txt
VanJS 创建真实 DOM
外部库接管局部行为
外部库回调用来改 VanJS state
state 变化如需通知外部库，明确调用 instance API
```

## Tippy 集成

示例项目：

```txt
vanilla-libs-van
```

文件：

```txt
src/TooltipDemo.js
```

核心：

```js
const count = van.state(0)
let tip

const el = button({
  onclick: () => {
    count.val += 1
    tip?.setContent(`点击了 ${count.val} 次`)
  },
}, () => `保存 ${count.val}`)

queueMicrotask(() => {
  tip = tippy(el, {
    content: `点击了 ${count.val} 次`,
  })
})
```

这里不要依赖 `van.derive` 自动同步外部实例。Tippy 实例不是 VanJS state，直接调用 `tip.setContent` 更清楚。

## SortableJS 集成

文件：

```txt
src/SortableDemo.js
```

核心：

```js
const items = van.state(initialItems)

const list = ul(
  { class: sortableListClass },
  items.val.map(item =>
    li({ "data-id": item.id }, item.text)
  )
)

queueMicrotask(() => {
  Sortable.create(list, {
    onEnd: () => {
      const orderedIds = Array.from(list.children).map(child => child.dataset.id)
      items.val = orderedIds
        .map(id => items.val.find(item => item.id === id))
        .filter(Boolean)
    },
  })
})
```

这里让 Sortable 临时改 DOM，拖动结束后把顺序回写 VanJS state。

注意：这种由外部库接管的列表，不要再写成：

```js
ul(..., () => items.val.map(...))
```

否则容易和外部库的 DOM 操作冲突，也可能出现 `[object HTMLElement]`。

## 构建产物怎么看

普通构建：

```txt
npm run build
dist/
```

可读构建：

```txt
npm run build:readable
dist-readable/
```

可读配置：

```js
export default defineConfig({
  build: {
    outDir: "dist-readable",
    minify: false,
    sourcemap: true,
  },
})
```

可读 bundle 里能看到：

```txt
node_modules/goober/...
node_modules/vanjs-core/...
node_modules/sortablejs/...
node_modules/@popperjs/core/...
node_modules/tippy.js/...
src/SortableDemo.js
src/TooltipDemo.js
src/main.js
```

默认 Vite 会把 JS 依赖打进一个 bundle，CSS 依赖打进 CSS asset。

goober 写的样式不会进入 CSS 文件，而是运行时插入 `<style id="_goober">`。

## Pick n Place 的真实思路

之前看的 `picknplace.js` 不是普通拖拽，它是：

```txt
点一下拿起
创建 fixed ghost
创建 absolute clone overlay
滚动页面时 ghost 固定在屏幕上
根据 ghost 中心点和下面元素位置算目标 index
clone 列表 transform 让位
点 Place 才确认排序
Cancel 清理中间层
```

它的价值在手机上：

```txt
手指不用一直按住
不会挡住目标位置
可以边滚动边找位置
```

接 VanJS 的正确方式：

```txt
VanJS 渲染真实列表和数据
picknplace 负责中间交互层
place 后把新顺序回写 VanJS state
不要让插件成为最终数据源
```

## VanX

VanX 可以优化列表：

```js
const memos = vanX.reactive([])

vanX.list(section, memos, (memo, deleter) =>
  article(...)
)
```

它会为每个 item 维护 DOM 映射，新增/删除/排序时更细粒度地动 DOM。

但它多一层心智：

```txt
vanX.reactive
vanX.list
vanX.replace
vanX.compact
stateFields
```

现在可以先不用。memos 这种应用可以分页/按日期分组：

```txt
最近 30 条
更多
今天/昨天/本周
搜索结果
标签过滤
```

人眼本来就看不过来几千条，分页/过滤比过早列表优化更重要。

## 当前建议

短期：

```txt
继续 VanJS + goober
普通 van.state([])
section(() => memos.val.slice(0, limit.val).map(...))
localStorage 持久化
```

中期：

```txt
按日期分组
分页/更多
搜索
标签
Markdown/linkify/DOMPurify
```

后期如果需要：

```txt
VanX
虚拟列表
IndexedDB / SQLite
Wails / Capacitor / 原生端
```

核心原则：

```txt
低频业务状态交给 VanJS
静态样式交给 goober
高频动画/拖拽交给 DOM API/CSS/专门库
外部库只做局部能力，最终数据回到 VanJS state
```
