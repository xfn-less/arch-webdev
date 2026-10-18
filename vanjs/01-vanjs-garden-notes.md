# VanJS / Garden 学习笔记

这份笔记总结当前做 `garden` 这个 memos 类小应用时形成的理解。目标不是背 API，而是建立一个能推演的模型：HTML 是结构，CSS 是表现，VanJS 是用 JavaScript 脚本化地构造和绑定 UI。

## 1. Garden 的目标

先做一个最小 memos：

```txt
输入一段文本
点击 save
下面新增一条 memo
后续再加清空、Enter 保存、日期、localStorage、Markdown、搜索
```

第一版不要上复杂编辑器。对 memos/Obsidian 这类短内容，先用：

```txt
textarea + 纯文本/Markdown 原文
```

比 `pell` 这种 `contenteditable + execCommand` 富文本方案更稳。`pell` 适合实验，但长期内容系统最好保存可控文本。

## 2. HTML 标签理解

很多语义标签功能上像 `div`，默认主要是 `display: block`，区别在语义树、可访问性、阅读器、搜索引擎和代码可读性。

常用分类：

```txt
有实际行为：
a img input textarea button form details summary dialog select video audio

主要语义结构：
main article nav header footer section aside figure figcaption time address
```

对 `garden`：

```txt
main      整个应用主区域
header    标题/顶部操作
nav       标签、日期、快捷入口
section   发布区、列表区
article   一条 memo
time      memo 时间
footer    memo 操作区
div       无明确语义时的布局容器
```

## 3. textarea 的数据流

`textarea` 自己有 DOM 属性：

```txt
textarea.value
```

`oninput` 事件里的：

```js
e.target.value
```

就是“触发这次 input 事件的 textarea 当前值”。

数据流：

```txt
用户输入
-> textarea.value
-> e.target.value
-> draft.val
```

这里的 `draft.val` 是你的程序状态，存在内存里。刷新页面会丢，除非再保存到 `localStorage` / IndexedDB / 后端。

## 4. VanJS 的核心模型

VanJS 作者 Tao Xin 在 About 页里说：

```txt
VanJS is the scripting language for UI,
just like bash is the scripting language for terminal.
```

它的核心是：

```txt
用 JavaScript 函数构造 DOM
用 state/binding 让 DOM 响应变化
尽量接近原生 JavaScript
无 JSX、无虚拟 DOM、无隐藏大框架
```

标签本质就是函数：

```js
tag(props?, ...children)
```

例如：

```js
h1("Memos")
p(draft)
section(...)
```

固定值直接传值；动态值传函数；直接传 state 是 VanJS 提供的简写。

## 5. `.val` 和包函数的统一规则

先问：

```txt
我现在是在描述 DOM 本身？
还是在写普通 JS 动作？
```

### 5.1 普通 JS 动作区

例如：

```txt
onclick
oninput
console.log
数组操作
if 判断
localStorage 保存
生成 id
格式化时间
```

这里没有 VanJS 渲染语法糖。

规则：

```txt
读 state：用 .val
不需要为了响应式 UI 外包
```

例子：

```js
oninput: e => draft.val = e.target.value
```

```js
onclick: () => {
  if (!draft.val.trim()) return
  memos.val = [...memos.val, draft.val]
}
```

### 5.2 DOM 描述区：静态值

```js
h1("Memos")
button("save")
```

规则：

```txt
不用 .val
不用包
```

因为内容固定，只创建一次。

也可以概念上理解为：

```js
h1(() => "Memos")
```

但没有必要，因为没有 state 依赖。

### 5.3 DOM 描述区：直接绑定 state

```js
p(draft)
textarea({ value: draft })
```

规则：

```txt
不用 .val
不用显式包
```

因为 VanJS 内部识别 state，帮你做了隐式绑定。可以理解成：

```js
p(draft)
```

约等于：

```js
p(() => draft.val)
```

这就是省略写法，本质还是读了 `.val`。

### 5.4 DOM 描述区：根据 state 计算文本或属性

```js
p(() => `字数：${draft.val.length}`)
```

```js
div({ class: () => active.val ? "on" : "off" })
```

规则：

```txt
要 .val
要包
```

因为你自己写了计算，VanJS 需要一个函数，以便 state 变化时重新执行。

### 5.5 DOM 描述区：根据 state 生成 DOM 结构

动态列表：

```js
() => section(
  memos.val.map(memo => article(memo))
)
```

规则：

```txt
要 .val
要包
函数顶层返回一个 DOM 节点或文本
```

原因：

```txt
memos.val.map(...) 的结果是数组
数组可以作为标签函数 children，VanJS 会 flat
但响应式函数的顶层返回值不要直接返回数组
```

错误模式：

```js
section(
  () => memos.val.map(memo => article(memo))
)
```

这里函数返回的是数组，容易显示成：

```txt
[object HTMLElement],[object HTMLElement]
```

正确模式：

```js
() => section(
  memos.val.map(memo => article(memo))
)
```

这里函数顶层返回的是一个 `section` 节点，`map` 出来的数组在 `section(...)` 里面作为 children 被 VanJS 拍平。

## 6. 最短判断表

```txt
普通 JS 动作：
  用 .val，不包

静态 DOM：
  不用 .val，不包

DOM 直接 state：
  不用 .val，不显式包，VanJS 隐式包

DOM 计算 state：
  用 .val，包

DOM 生成结构：
  用 .val，包，顶层返回一个节点
```

另一个角度：

```txt
固定值 -> 直接写
变化值 -> 函数
state 原样显示/绑定 -> VanJS 帮你省略函数和 .val
自己计算 state.val -> 自己写函数
```

## 7. map 的理解

`map` 是数组方法：

```txt
把数组里的每一项，转换成另一种东西，得到一个新数组
```

例如：

```js
["a", "b"].map(x => article(x))
```

结果是：

```txt
[article("a"), article("b")]
```

在 VanJS 里：

```js
section(
  memos.val.map(memo => article(memo))
)
```

意思是：

```txt
把 memos.val 里的每条 memo 变成 article
再放进 section
```

如果这个列表要随 `memos.val` 变化，就让整个列表构造过程变成动态函数：

```js
() => section(
  memos.val.map(memo => article(memo))
)
```

## 8. 当前 Garden 的下一步

当前已经有：

```txt
draft state
memos state
textarea 输入更新 draft
save 把 draft.val 加进 memos.val
```

接下来按小步做：

```txt
1. 用动态 section 正确渲染 memos 列表
2. save 后清空 draft
3. textarea 绑定 value: draft
4. 空内容不保存
5. Enter 保存，Shift+Enter 换行
6. 加 id / createdAt
7. 加 localStorage
8. 加样式
```

不要急着做完整成品。每一步只验证一个概念。

## 9. 学习方式

适合纸笔流程：

```txt
纸上想结构树
屏幕上翻译成 VanJS
浏览器验证
再回纸上修
```

例如：

```txt
目标：
输入内容，点击 save，下面新增一条

状态：
draft = 当前输入
memos = 已保存列表

动作：
textarea input -> draft.val = 当前输入
save click -> memos.val 添加 draft.val

显示：
memos 中每一项 -> article
```

这样不是在屏幕上凭空想，而是把设计外部化。

## 10. 工程取向

当前项目适合追求 intellectual control：

```txt
核心模型简单
数据结构清楚
状态变化可推演
少依赖
少魔法
先本地，再后端
```

对 memos 类工具：

```txt
核心逻辑追求形式清楚
边界问题追求经验稳健
```

先做：

```txt
textarea + text/markdown + localStorage
```

再逐步加：

```txt
Markdown 渲染
DOMPurify
MiniSearch
IndexedDB
多账号/后端
```

## 11. `onclick`、作用域和闭包

这一节记录删除 memo 时遇到的问题。重点不是删除本身，而是理解：

```txt
onclick 后面到底放了什么
变量作用域在哪里
为什么写在里面能访问 memo
为什么抽出去后要传参数
```

### 11.1 `onclick` 后面放的是函数

VanJS 里：

```js
button({ onclick: addMemo }, "保存")
```

意思是：

```txt
点击按钮时，浏览器调用 addMemo
```

浏览器调用事件函数时，会自动传入一个事件对象：

```js
addMemo(event)
```

如果 `addMemo` 不接参数：

```js
const addMemo = () => {
  // ...
}
```

那么这个 `event` 会被忽略，所以这样写没问题：

```js
onclick: addMemo
```

### 11.2 需要自己的参数时要包一层

删除某条 memo 时，需要知道删哪一条。

如果写：

```js
onclick: delMemo
```

点击时浏览器实际传进去的是：

```js
delMemo(event)
```

但我们想要的是：

```js
delMemo(memo.id)
```

所以要包一层箭头函数：

```js
onclick: () => delMemo(memo.id)
```

意思是：

```txt
点击时先执行这个小函数
这个小函数再把当前 memo.id 传给 delMemo
```

注意，不要写成：

```js
onclick: delMemo(memo.id)
```

这不是点击时执行，而是渲染按钮时立刻执行。

区别：

```txt
onclick: addMemo
点击时执行 addMemo，适合不需要自定义参数

onclick: () => delMemo(memo.id)
点击时执行箭头函数，再由箭头函数传入 memo.id

onclick: delMemo(memo.id)
现在立刻执行 delMemo，把返回值给 onclick
```

### 11.3 写在 `map` 里面为什么能访问 `memo`

直接写在删除按钮里：

```js
memos.val.map((memo) =>
  article(
    p(memo.content),
    button(
      {
        onclick: () => {
          const nextMemos = memos.val.filter((item) => memo.id !== item.id)
          setMemos(nextMemos)
        },
      },
      "删除",
    ),
  )
)
```

这里的 `memo` 来自：

```js
memos.val.map((memo) => ...)
```

每次 `map` 都会产生一个新的作用域：

```txt
第 1 次 map：memo = 第一条
第 2 次 map：memo = 第二条
第 3 次 map：memo = 第三条
```

删除按钮的 `onclick` 函数是在这个作用域里面创建的，所以它能访问当前这条 `memo`。

这就是闭包：

```txt
函数会记住它创建时能访问到的外层变量
```

所以可以理解成：

```txt
第一条按钮记住第一条 memo
第二条按钮记住第二条 memo
第三条按钮记住第三条 memo
```

### 11.4 抽到外面为什么不能直接用 `memo`

如果写：

```js
const delMemo = () => {
  setMemos(memos.val.filter((item) => memo.id !== item.id))
}
```

这个函数定义在 `App` 作用域里。

`App` 作用域里有：

```txt
draft
memos
setMemos
addMemo
delMemo
```

但没有：

```txt
memo
```

`memo` 只存在于：

```js
memos.val.map((memo) => ...)
```

这个更里面的作用域。

作用域方向可以这样记：

```txt
内层能访问外层
外层不能访问内层
```

结构是：

```txt
App 作用域
├─ draft
├─ memos
├─ setMemos
├─ addMemo
├─ delMemo
└─ map 回调作用域
   ├─ memo
   └─ onclick 回调作用域
      └─ 可以访问 memo
```

所以：

```txt
onclick 里能访问 memo
App 外层的 delMemo 不能直接访问 memo
```

### 11.5 抽函数时用参数传进去

如果想把删除逻辑抽出来，推荐按 id 删除：

```js
const delMemo = (id) => {
  setMemos(memos.val.filter((item) => item.id !== id))
}
```

然后在有 `memo` 的地方传入：

```js
onclick: () => delMemo(memo.id)
```

逻辑是：

```txt
onclick 在 map 里面，所以知道 memo.id
点击时，把 memo.id 传给外层 delMemo
delMemo 不需要知道 memo 是谁，只根据 id 删除
```

也可以传整个 memo：

```js
const delMemo = (memo) => {
  setMemos(memos.val.filter((item) => item.id !== memo.id))
}
```

按钮：

```js
onclick: () => delMemo(memo)
```

但删除只需要 id，所以传 id 更清楚。

### 11.6 学习阶段可以先写在里面

学习阶段可以先不抽函数，直接写在 `onclick` 里面：

```js
button(
  {
    class: "delBtn",
    onclick: () => {
      const nextMemos = memos.val.filter((item) => memo.id !== item.id)
      setMemos(nextMemos)
    },
  },
  "删除",
)
```

这样最直观：

```txt
点当前这条 memo 的删除按钮
拿当前 memo.id
过滤掉这条
setMemos 更新 state 并保存
```

等删除逻辑变长，比如要加确认、toast、撤销，再抽成函数。

### 11.7 和 localStorage 的关系

之前没有持久化时，删除只要：

```js
memos.val = memos.val.filter((item) => memo.id !== item.id)
```

这只改内存，刷新页面会丢。

加了保存后，需要：

```js
const nextMemos = memos.val.filter((item) => memo.id !== item.id)
memos.val = nextMemos
saveMemos(nextMemos)
```

为了避免新增和删除都重复这两步，可以写：

```js
const setMemos = (nextMemos) => {
  memos.val = nextMemos
  saveMemos(nextMemos)
}
```

然后新增、删除统一走：

```js
setMemos(nextMemos)
```

但这是抽象。学习阶段先写展开版也可以。
