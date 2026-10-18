# VanJS 学习总结与后续练习路线

这份文档记录当前这一轮 VanJS 学习的结论、思考和后续练习路线。目的不是做 API 手册，而是给新对话一个清楚的上下文：已经理解了什么，为什么选择 VanJS，接下来该练什么。

## 1. 当前路线

现在的学习路线可以总结成：

```text
先不追成熟框架生态
先通过小框架和原生 JS 理解前端核心
用 VanJS 作为练习入口
再回头看 React/Vue/Solid 时理解它们到底补了什么
```

选择 VanJS 不是为了学冷门框架，而是为了通过一个源码很小、抽象很少的框架，看清楚：

```text
DOM 是怎么创建的
事件怎么改变数据
数据怎么驱动页面
状态怎么和 DOM 绑定
列表和条件渲染怎么做
组件其实可以只是函数
框架到底帮你省了什么
```

这条路线和个人偏好一致：

```text
KISS
少抽象
源码能读完
可以组合 JS 生态
不依赖复杂构建也能跑
学到的是 JS/DOM/CSS 本身
```

## 2. VanJS 的核心心智

VanJS 可以压缩成一句话：

```text
VanJS = DOM 创建函数 + getter/setter 状态 + 自动依赖收集 + 微任务批量更新。
```

更具体一点：

```text
van.tags   创建真实 DOM
van.add    把 DOM 加到已有节点
van.state  创建可响应状态
van.derive 创建派生状态或副作用
binding    把 state/函数放进 DOM，状态变后自动更新
```

它不是虚拟 DOM，不是模板编译，不是 JSX。它生成的是真实 DOM 对象：

```js
const { div, p } = van.tags

const paragraph = p("hello")
const root = div(paragraph)

console.log(paragraph.constructor.name)
// HTMLParagraphElement

console.log(root.outerHTML)
// <div><p>hello</p></div>
```

所以 VanJS 学习会自然回到浏览器 DOM API：

```text
HTMLElement
HTMLDivElement
HTMLParagraphElement
append
appendChild
outerHTML
isConnected
parentNode
事件监听
```

这点很重要：VanJS 不是把 DOM 藏起来，而是让 DOM 更容易写。

## 3. `van.tags` 与 hyperscript

基础写法：

```js
const { a, div, li, p, ul } = van.tags

const Hello = () => div(
  p("👋Hello"),
  ul(
    li("🗺️World"),
    li(a({ href: "https://vanjs.org/" }, "🍦VanJS")),
  ),
)

van.add(document.body, Hello())
```

规则可以记成：

```text
tag(props?, ...children)
```

也就是：

```text
函数名 = 标签名
第一个普通对象 = HTML 属性
后面的参数 = children
```

例如：

```js
a({ href: "https://vanjs.org/" }, "VanJS")
```

对应：

```html
<a href="https://vanjs.org/">VanJS</a>
```

这个写法就是 hyperscript 风格：

```text
HTML 标签嵌套
换成
JS 函数嵌套
```

和 JSX 本质接近，都是用 JS 描述 UI。区别是：

```text
JSX 看起来像 HTML，但需要编译成函数调用
VanJS 直接写函数调用，不需要编译
```

## 4. props 判断规则

VanJS 怎么知道第一个参数是不是属性对象？

核心规则：

```text
只有第一个参数是普通 Object，才当作 props。
否则所有参数都当 children。
```

所以：

```js
div({ class: "box" }, p("hello"))
```

解释成：

```text
props = { class: "box" }
children = [p("hello")]
```

而：

```js
div(p("hello"), p("world"))
```

解释成：

```text
props = {}
children = [p("hello"), p("world")]
```

DOM 节点虽然也是对象，但不是普通 Object，而是 `HTMLParagraphElement` 等，所以不会被当成 props。

这个细节很重要。理解规则后，写起来更踏实。

## 5. `van.add`

`van.add` 的本质：

```js
van.add(dom, ...children) => dom
```

意思是：把 children append 到已有 DOM 上，并返回这个 DOM。

例如：

```js
const root = div()

van.add(root, p("hello"), p("world"))

console.log(root.outerHTML)
// <div><p>hello</p><p>world</p></div>
```

所以：

```js
van.add(document.body, App())
```

本质就是：

```text
把 App() 返回的真实 DOM 挂到 body 里。
```

它接近原生：

```js
document.body.appendChild(App())
```

只是 VanJS 支持更多 child 类型：

```text
DOM 节点
文本/数字
数组
嵌套数组
null / undefined
State
函数 child
```

## 6. DOM 节点为什么会移动

真实 DOM 是树结构，一个节点只能有一个父节点。

```js
const node = p("hello")

const a = div(node)
const b = div(node)
```

这不会复制两个 `<p>`，而是同一个 `node` 被移动到最后一个位置。

原因：

```text
DOM 节点是 JS 对象
变量保存的是对象引用
同一个 DOM 对象不能同时出现在两个父节点下
```

如果想生成多个一样的 DOM，应写函数：

```js
const Text = () => p("hello")

const a = div(Text())
const b = div(Text())
```

每次调用 `Text()`，都会重新执行 `p("hello")`，底层重新 `document.createElement("p")`，所以得到新节点。

这和 JS 对象引用、深浅拷贝很像：

```text
复用 DOM 变量 = 复用同一个对象
cloneNode(false) = 浅复制 DOM
cloneNode(true) = 深复制 DOM 子树
函数组件 = 重新执行创建逻辑，生成新对象
```

DOM 移动也可以有稳定用途：

```text
移动弹窗
拖拽排序
保留 input/focus/scroll 状态
把同一个 widget 从一个区域搬到另一个区域
```

但要清楚语义：

```text
复用 DOM 节点 = 搬同一个东西
复用组件函数 = 造一个新的东西
```

## 7. 组件就是普通函数

VanJS 组件没有特殊运行时。组件就是：

```text
普通 JS 函数，返回 DOM。
```

例如：

```js
const Card = ({ title, content }) =>
  div(
    { class: "card" },
    h2(title),
    p(content),
  )
```

调用：

```js
Card({ title: "VanJS", content: "Hello" })
```

返回真实 DOM。

所以：

```text
div / p / button 是 VanJS 提供的标签函数
Card / TodoItem / TreeNode 是自己写的函数
```

它们都只是返回 DOM。

函数组件的意义：

```text
保存创建逻辑
每次调用创建新 DOM
函数内部可以创建独立 state
```

例如：

```js
const Counter = () => {
  const count = van.state(0)

  return div(
    button({ onclick: () => --count.val }, "-"),
    count,
    button({ onclick: () => ++count.val }, "+"),
  )
}
```

每次调用 `Counter()`，都有新的 `count`、新的 DOM、独立状态。

## 8. State

`van.state` 是函数：

```js
const count = van.state(0)
```

`count` 不是数字，而是一个 State 对象。真正的值在：

```js
count.val
```

读：

```js
count.val
```

写：

```js
count.val = 1
```

VanJS 内部通过 getter/setter 拦截属性读写：

```text
get val()  拦截读取
set val()  拦截修改
```

这可以理解成 JS 语言层面的“属性访问钩子”：

```text
读属性时触发 get
写属性时触发 set
```

VanJS 利用它：

```text
读 state.val 时收集依赖
写 state.val 时通知更新
```

`__proto__` 在源码里用于让 state 对象继承公共的 getter/setter 行为。业务代码不用模仿这种写法，只要能读懂即可。

## 9. State 不可变更新

VanJS 监听的是：

```text
state.val 的赋值
```

不是数组/对象内部的深层变化。

例如：

```js
const todos = van.state([])
```

不推荐：

```js
todos.val.push(newTodo)
```

因为没有触发：

```js
todos.val = ...
```

推荐：

```js
todos.val = [...todos.val, newTodo]
```

对象也一样：

```js
const user = van.state({ name: "xiang", age: 18 })
```

不推荐：

```js
user.val.age++
```

推荐：

```js
user.val = {
  ...user.val,
  age: user.val.age + 1,
}
```

规则：

```text
VanJS 只盯着你声明的 state.val 这一层。
想让 UI 更新，就给 state.val 赋新值。
```

这也引出了 state 粒度问题：

```text
大对象 state：统一，但更新要整体替换
多个小 state：清楚，但状态分散
```

学习阶段推荐：

```js
const todos = van.state([])
const filter = van.state("all")
const editingId = van.state(null)
```

不要一开始就写复杂嵌套 state：

```js
const app = van.state({
  count: van.state(1),
})
```

这能跑，但会让依赖层级变复杂。更清楚的二选一是：

```js
const app = van.state({
  count: 1,
  name: "xiang",
})
```

或：

```js
const app = {
  count: van.state(1),
  name: van.state("xiang"),
}
```

## 10. derive 与自动依赖收集

`van.derive` 类似数学函数：

```text
y = f(x)
```

例如：

```js
const count = van.state(1)
const doubled = van.derive(() => count.val * 2)
```

`count` 变，`doubled` 自动重新计算。

对应其他框架：

```text
VanJS   van.derive
Vue     computed
Solid   createMemo
MobX    computed
Svelte  $:
React   通常直接 render 里算，或 useMemo
```

自动依赖收集原理：

```text
derive 函数执行期间
谁的 state.val 被读取
谁就登记这个 derive
以后这个 state 变了
derive 重新执行
```

不是扫描源码，不是 AI 理解，不是编译器分析，而是运行时 getter 被触发。

所以：

```js
const x = count.val
const doubled = van.derive(() => x * 2)
```

不行。因为 `count.val` 在 derive 外面已经读完了，`x` 是普通数字。

正确：

```js
const doubled = van.derive(() => count.val * 2)
```

依赖触发层面是“或”：

```text
derive 里读过 A/B/C
A/B/C 任意一个变了
derive 就重新执行
```

但结果逻辑由 JS 自己写：

```js
const canSubmit = van.derive(() =>
  email.val.includes("@") &&
  password.val.length >= 8 &&
  agree.val
)
```

注意短路逻辑会影响动态依赖：

```js
agree.val && email.val.includes("@")
```

如果 `agree.val` 是 false，`email.val` 可能没被读到，就暂时不会成为依赖。想强制都读，就先取出来：

```js
const okEmail = email.val.includes("@")
return agree.val && okEmail
```

## 11. 副作用

`derive` 可以做两件事：

```text
1. 计算派生值
2. 在状态变化时执行动作
```

派生值：

```js
const doubled = van.derive(() => count.val * 2)
```

副作用：

```js
van.derive(() => {
  localStorage.setItem("count", count.val)
})
```

区别：

```text
派生状态：关心函数返回了什么
副作用：关心函数执行时干了什么
```

副作用影响函数外部世界：

```text
console.log
localStorage
document.title
fetch
setTimeout
WebSocket
第三方库
手动 DOM 操作
```

不用 `derive` 也能做副作用，可以显式写普通函数：

```js
const saveTodos = () =>
  localStorage.setItem("todos", JSON.stringify(todos.val))

const setTodos = next => {
  todos.val = next
  saveTodos()
}
```

学习阶段建议：

```text
优先显式普通函数，因果更清楚
熟悉后再用 derive 做 localStorage/document.title 这类自动同步
```

## 12. State Binding

State Binding 不是新概念，而是说明 state/函数可以放在 DOM 的哪些位置。

常见表：

```text
普通值作为 child      -> 变成 Text
DOM 节点作为 child    -> append 进去
数组作为 child        -> 展开
state 作为 child      -> 文本跟随 state.val
函数作为 child        -> 返回值跟随函数里读到的 state

普通值作为 prop       -> 设置属性
state 作为 prop       -> 属性跟随 state.val
函数作为 prop         -> 属性跟随函数里读到的 state
on... 函数 prop       -> 事件监听
```

最基础闭环：

```js
const name = van.state("world")

input({
  value: name,
  oninput: e => name.val = e.target.value,
})

span("Hello ", name)
```

心智：

```text
state -> DOM
event -> state
state -> DOM 更新
```

这是所有前端应用的最小模型：

```text
数据在哪里？
用户怎么改数据？
数据改了页面哪里变？
```

## 13. 条件渲染、列表渲染、二维数组

VanJS 不需要额外模板语法，直接用 JS。

条件：

```js
div(() =>
  loggedIn.val
    ? p("Welcome")
    : p("Please login")
)
```

列表：

```js
ul(items.map(item => li(item)))
```

表格生成器：

```js
const { table, tbody, thead, td, th, tr } = van.tags

const Table = ({ head, data }) => table(
  head ? thead(tr(head.map(h => th(h)))) : [],
  tbody(data.map(row => tr(
    row.map(col => td(col)),
  ))),
)
```

这里练的是：

```text
二维数组
map
条件渲染
函数组件
数据结构 -> DOM 结构
```

一开始懵是正常的。写代码不是考试，不会就先保存片段，写的时候抄，多用就有语感。

## 14. VanJS 与 React 的关系

VanJS 能覆盖 React 常用 UI 能力的大部分：

```text
组件              普通函数
props             函数参数
children          rest 参数 / 数组
state             van.state
computed          van.derive
事件              on...
条件渲染           三元 / 函数 child
列表渲染           map
ref               直接拿 DOM
portal            van.add(document.body, dom)
```

VanJS 少的是 React 那套大型组件运行时和生态约定：

```text
组件实例托管
hooks 规则
key/reconciliation
context
effect cleanup
error boundary
Suspense
DevTools
成熟 SSR 框架
生态标准答案
```

但从学习和个人项目角度，这些不一定是缺点。很多东西可以用 JS/DOM 自己写：

```text
context        -> 闭包 / 模块对象 / 参数传递
ref            -> 直接拿 DOM
portal         -> van.add(document.body, dom)
fragment       -> 数组 / DocumentFragment
router         -> hashchange + state
async UI       -> loading/error/data 三个 state
error boundary -> try/catch
cleanup        -> 自己约定
keyed list     -> 自己写或用 VanX/list
```

结论：

```text
VanJS 不缺表达能力，缺的是现成的大框架规训。
而当前目标正是练这些规训背后的原理。
```

## 15. VanUI

VanUI 是作者写的一组极简 VanJS UI 组件：

```text
Await
Modal
Tabs
MessageBoard
Tooltip
Toggle
Banner
Choose
OptionGroup
FloatingWindow
```

它不是完整 UI 框架，本质是：

```text
一组函数组件/小类
内部用 VanJS state/event/DOM
给默认 inline style
允许传 class/styleOverrides 覆盖
```

适合作为“如何封装 VanJS 组件”的源码范例。

学习价值：

```text
props 怎么设计
children 怎么传
内部 state 怎么组织
事件怎么暴露
默认样式怎么写
如何留 class/styleOverrides 扩展口
```

本地已经做过一个全组件预览：

```text
Drafts/vanjs/vanjs-projects/van/components/examples/all
```

## 16. Mini-Van

Mini-Van 是 VanJS 的瘦身版：

```text
保留 DOM/HTML 组合写法
去掉 state / derive / binding
可以在服务端生成 HTML
```

它有两种服务端模式：

### van-plate mode

这是最适合 SSG/博客的路线。

```text
hyperscript 写法 -> 可 render 的模板对象 -> HTML 字符串
```

例如：

```js
import van from "mini-van-plate/van-plate"

const { body, p } = van.tags

van.html(
  body(
    p("hello")
  )
)
```

输出完整 HTML 字符串。

特点：

```text
不需要 jsdom
轻
快
适合 SSG/SSR 输出 HTML
没有真实 DOM API
```

### mini-van mode

这是模拟 DOM 模式。

Node 没有浏览器的：

```text
document
document.createElement
HTMLElement
outerHTML
querySelector
```

所以要用 `jsdom` 或 `deno-dom` 提供模拟 DOM。

特点：

```text
需要 DOM 库
可以用 DOM API
更像浏览器
适合测试/HTML 后处理/复用依赖 DOM API 的代码
```

当前路线：

```text
博客/SSG：优先 van-plate
需要 DOM API 后处理：再考虑 mini-van + jsdom
```

## 17. SSR、CSR、SSG、Hydration

几个概念：

```text
CSR：浏览器端渲染
SSR：服务器端每次请求渲染
SSG：构建时提前生成 HTML
Hydration：让已有 HTML 变可交互
```

可以用做饭比喻：

```text
CSR：客人自己拿原料到桌上用电磁炉炒
SSR：后厨接单现炒
SSG：提前做好的预制菜/冷盘
SSG + 局部 JS：预制菜上桌，桌边再加一点现拌/点火
SSR + Hydration：后厨现炒端上来，服务员再在桌边继续服务
```

越接近原材料：

```text
越灵活
越需要服务器/浏览器现场计算
越可能慢
越复杂
```

越接近预制结果：

```text
越快
越便宜
越稳定
越不灵活
```

大致选择：

```text
内容固定：SSG
每人不同/请求相关：SSR
页面主要是工具：CSR
内容固定但有一点互动：SSG + 局部 VanJS
```

VanJS 里的 hydration：

```js
van.hydrate(existingDom, oldDom => NewDom)
```

它很直白：

```text
找到旧 DOM
读取旧 DOM 信息
重新创建响应式 DOM
用新 DOM 替换旧 DOM
```

和：

```js
van.add(document.body, App())
```

区别：

```text
van.add：追加一个全新的 DOM
van.hydrate：接管/替换已有 DOM
```

共享组件和 hydrate 不是强绑定：

```text
共享组件 = 代码组织方式
hydrate = 浏览器端接管已有 DOM 的动作
```

共享组件不是运行时跨服务器共享内存，而是：

```text
同一份源码，在构建时分别打进服务端 bundle 和客户端 bundle。
```

## 18. VanX

VanX 是 VanJS 官方扩展，核心是让复杂对象/数组状态更舒服。

一句话：

```text
VanJS 管单个 state 很轻；
VanX 让对象/数组里的每个字段都像 state 一样可响应。
```

### `vanX.reactive`

把普通对象/数组变成响应式对象：

```js
const data = vanX.reactive({
  name: { first: "Tao", last: "Xin" },
})
```

之后可以像普通对象一样写：

```js
data.name.first
data.name.first = "Xiang"
```

背后是：

```text
Proxy + van.state
```

读字段等于读隐藏 state 的 `.val`，写字段等于写隐藏 state 的 `.val`。

仍然要注意依赖收集：

```js
span(() => data.name.first)
```

不要提前别名：

```js
const first = data.name.first
span(() => first)
```

这样依赖会断。

### `vanX.calc`

类似 `van.derive`：

```js
const derived = vanX.reactive({
  fullName: vanX.calc(() => `${data.name.first} ${data.name.last}`),
})
```

### `vanX.stateFields`

拿到底层 state：

```js
vanX.stateFields(data).name
```

日常不常用，但当 VanJS API 需要 state 对象时有用。

### `vanX.raw`

读取字段但不登记依赖：

```js
vanX.calc(() => vanX.raw(data).a + data.b)
```

只依赖 `b`，不依赖 `a`。

### `vanX.noreactive`

告诉 VanX 某个对象不要被 Proxy 包：

```js
vanX.noreactive(new ArrayBuffer(8))
```

适合：

```text
ArrayBuffer
File
Blob
第三方库实例
DOM 节点
编辑器实例
```

### `vanX.list`

重点。用响应式数组/对象生成列表，并尽量少重渲染。

```js
const items = vanX.reactive([1, 2, 3])

vanX.list(ul, items, v => li(v))
```

`v` 是每一项对应的 state。

对象形式更像 keyed list：

```js
const items = vanX.reactive({
  a: "A",
  b: "B",
})

vanX.list(ul, items, (v, deleter, key) =>
  li(key, ": ", v, button({ onclick: deleter }, "x"))
)
```

适合笔记软件：

```text
notesById
folderTree
todoItems
outline nodes
```

### `vanX.replace`

批量替换/更新/排序/删除：

```js
vanX.replace(items, list =>
  list.filter(item => !item.done)
)
```

价值：

```text
可以传整个新数据
VanX 内部做 diff
只更新真正变化的叶子字段
尽量保持已有 DOM 绑定
```

### `vanX.compact`

VanX 为了减少列表重渲染，删除数组项时可能产生 holes：

```js
[1, empty, 3]
```

JSON 序列化会把 hole 变成 `null`。保存前要：

```js
JSON.stringify(vanX.compact(items))
```

适合：

```text
localStorage
导出 JSON
发送给后端
```

VanX 总结：

```text
reactive：对象/数组字段响应式
list：列表 DOM 更聪明地更新
replace：批量更新和 smart diff
compact：序列化前清理
```

## 19. 例子页里值得继续拆的三个方向

已经大致看完整个 “VanJS Learning by Example”。后续最值得拆的是这三个：

### Tree-View JSON Inspector

核心：

```text
对象/数组
-> 递归遍历
-> 每一层生成一行 DOM
-> 子节点继续调用自己
```

适合笔记软件：

```text
左侧层级导航
文件夹树
标题大纲
块/子块结构
JSON/YAML frontmatter inspector
```

### Textarea with Autocomplete

核心：

```text
textarea 输入
oninput 更新 text state
根据光标附近词算 suggestions
显示候选列表
上下选择
Enter/Tab 插入候选
```

适合笔记软件：

```text
[[ 笔记链接补全
# 标签补全
/ 命令菜单
@ 引用补全
: 表情/符号补全
```

### HTML/MD to VanJS Code Converter

核心：

```text
HTML/Markdown
-> 解析成结构
-> 遍历节点
-> 生成 VanJS 函数调用代码
```

价值：

```text
理解 HTML 与 VanJS 函数结构的一一对应
学习解析器/转换器思路
以后可用于 Markdown/HTML 到组件/预览的转换
```

## 20. CSS 方向

试过几种：

```text
外部 CSS
goober CSS-in-JS
CSS Modules
```

结论：

```text
goober 能和 VanJS 组合，一个文件写组件+样式
但 CSS 太多时 JS 文件会变挤
CSS Modules 更朴素，也足够用
```

现在更适合：

```text
小组件：inline style / 小 CSS 字符串都行
TodoMVC/应用：CSS Modules 或普通 CSS
先不迷恋 CSS-in-JS
```

## 21. 后端与整体技术路线

已经形成的总体路线：

```text
前端：VanJS / VanX / Mini-Van
后端：Node + Hono + SQLite 起步
大项目以后：Go
底层学习：Zig
```

VanJS、Go、Zig 的角色：

```text
VanJS：理解浏览器和 JS/DOM
Go：写可靠后端服务
Zig：理解内存、C、编译、系统
```

Zig 暂时作为底层知识线索，不急着用于业务后端。

Node 后端路线：

```text
小项目先 npm
后面学 esbuild 单文件打包
数据库优先 SQLite
Node 内置 sqlite 可以关注，但仍要看版本稳定性
```

## 22. “货物崇拜”与当前学习方式

这轮学习里，一个重要思考是避免 cargo cult：

```text
只复制外形，不理解因果。
```

前端里常见货物崇拜：

```text
必须 React
必须 Vite
必须 TypeScript
必须 Tailwind
必须某个状态库
必须复杂目录结构
```

这些工具都可能有价值，但问题应该是：

```text
它解决什么问题？
这个问题现在真的存在吗？
不用它的代价是什么？
用了它的代价是什么？
我能不能解释它的核心原理？
```

VanJS 的价值在于反过来：

```text
先理解 DOM
先理解事件
先理解 state
先理解数组/对象/函数
先理解浏览器怎么更新页面
```

但也要避免反向货物崇拜：

```text
不是大框架就一定坏
不是构建工具就一定多余
不是 TypeScript 就一定过度工程
```

真正原则是：

```text
按问题付费。
```

## 23. 低结构积木偏好

这一轮形成了一个很明确的偏好：

```text
少量原语
规则统一
组合自由
不是每个功能都给一个专门按钮
```

也就是：

```text
先要原语，不要套餐。
```

VanJS 像低结构积木：

```text
van.tags
van.add
van.state
van.derive
```

剩下回到 JS：

```text
函数
对象
数组
map/filter
if/三元
DOM API
fetch
localStorage
CSS
```

这和个人喜欢的 KISS、小源码、可组合路线一致。

选库标准：

```text
源码能不能读？
概念是不是少？
能不能单独替换？
是不是用普通 JS/DOM/CSS 思想组合？
不用它时迁移成本大不大？
```

## 24. 本地项目索引

当前相关项目在：

```text
Drafts/vanjs/
```

主要目录：

```text
vanjs-projects/
  van/                         VanJS 核心、VanX、VanUI
  mini-van/                    Mini-Van 源码
  converter/                   HTML/MD 转 VanJS converter
  vanjs-org.github.io/         官网源码、示例、文档生成器
  vanjs-importtag/             VS Code tag 自动导入扩展
  vanjsHelper/                 另一个辅助扩展

vanjs-todomvc/                 原 TS TodoMVC
vanjs-todomvc-js/              纯 JS/CDN 版
vanjs-todomvc-vite-js/         Vite + JS 版
vanjs-todomvc-goober/          goober CSS-in-JS 版
vanjs-todomvc-css-modules/     CSS Modules 版

vanjs-hydration-mini/          add vs hydrate 最小演示
```

后续推荐优先读：

```text
1. vanjs-todomvc-css-modules/src
2. vanjs-projects/vanjs-org.github.io/jsfiddle/demo/json-inspector/demo.js
3. vanjs-projects/vanjs-org.github.io/code/auto-complete-derived-props.js
4. vanjs-projects/converter/converter.ts
5. vanjs-projects/van/x/src/van-x.js
```

## 25. 新对话的练习路线

新对话可以直接从练习开始，不要再继续纯理论。

推荐顺序：

```text
1. 手写一个最小 Counter
2. 手写 input + span 双向绑定
3. 手写 list + add/delete
4. 手写 TodoMVC 简化版
5. 读 vanjs-todomvc-css-modules
6. 用 VanJS 自己写 Tree View
7. 写 Textarea Autocomplete
8. 用 VanX 重写 Todo/List
9. 用 Mini-Van 写一个静态博客页
10. 用 VanJS 给博客加评论/搜索局部交互
```

可以这样开启新对话：

```text
我已经过了一遍 VanJS 文档、VanUI、Mini-Van、SSR/Hydration、VanX。
现在请带我从练习开始，先从最小 Counter 和 TodoMVC 读代码做起。
请慢一点，一层一层剥，重点解释 JS/DOM/状态/事件/数组更新。
```

## 26. 当前最重要的结论

最后总结成几句话：

```text
VanJS 不是玩具，它是小核心。
它不缺表达能力，缺的是成熟框架的默认制度。
而当前目标正是通过少量原语练出前端基本功。
```

```text
VanJS 写交互。
VanX 管复杂对象/列表。
Mini-Van/van-plate 生成静态 HTML。
hydrate 接管已有 DOM。
普通 JS 生态补路由、存储、编辑器、搜索、请求。
```

```text
先把小积木玩熟。
以后再回 React/Vue/Solid，就能看懂它们到底多做了什么，而不是被仪式感带着走。
```
