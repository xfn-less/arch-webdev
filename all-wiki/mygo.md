# MyGo

技术考察。用之前以仓库里的最新文档为准，下面是读 v0.10.0 时留下的轮廓。

来源：

- 文档目录：https://github.com/egoist/mygo/tree/main/docs
- 总览：https://github.com/egoist/mygo/blob/main/docs/README.md
- 站点：https://mygo.run
- 本机读过的副本：`github.com/egoist/mygo@v0.10.0`，在模块缓存的 `docs/`

## 它是什么

一个用 Go 写的程序，窗口有两种，一个程序里可以并存：

- 系统网页：macOS WKWebView、Linux WebKitGTK、Windows WebView2。前端是 HTML / CSS / JS，通过生成的 TypeScript 客户端调 Go。
- 自绘界面：包 `ui`，只写 Go，画在 GPU 上（桌面 Metal / Direct3D 11 / OpenGL）。没有 HTML，也没有 webview。

桌面编译不用 cgo。见文档 README 的 Requirements。

## 我在乎的

浏览器里给人打开的产品，继续用 Go 和 VanJS。要装在本机、马上打开、离线、或者要碰系统的小工具，看 MyGo 的自绘窗口。已经有网页、又要托盘、快捷键、通知时，用它的系统网页窗口，JS 不用重写。

文档是目录，不是课本。用到哪一类能力，打开对应那一页。版本还在 0.x，接口会动，所以以 `main` 上的文档为准。

## 大致原理

自绘界面里，视图是一个 Go 函数，按当前状态把界面再描述一遍。按钮、表格这些调用不是一套活着的控件对象树。文件框、通知、剪贴板、托盘、菜单、全局快捷键、正在播放、密钥、文件监视写在 Go 里，两种窗口都能调。见 [Desktop APIs](https://github.com/egoist/mygo/blob/main/docs/native.md)。

手机也是同一个程序：系统 WebView，或 GPU 自绘（iOS Metal，Android OpenGL ES）。菜单栏、托盘、全局快捷键在手机上没有。见 [Phones and tablets](https://github.com/egoist/mygo/blob/main/docs/mobile/README.md)。

## 怎么用

要 Go 1.27 或更新。只有带网页前端的项目才要 Bun。

```sh
go run github.com/egoist/mygo/cmd/mygo@latest init my-app
```

也可以 `go install github.com/egoist/mygo/cmd/mygo@latest`。步骤在 [Getting started](https://github.com/egoist/mygo/blob/main/docs/getting-started.md)。

自绘窗口把 `ui.View` 交给 `mygo.NewWindow`。网页窗口给 `URL`。例子在文档总览。

桌面自绘在 Linux 上还要系统里有 GTK 3。带网页的窗口另要 WebKitGTK 或 Windows 的 WebView2。编 iOS 要一台 Mac 和 Xcode，编 Android 要 NDK。这些是链接和签名用的，桌面程序不用装。见文档 README 和 mobile/README。

## 文档地图

| 要看什么 | 页 |
|---|---|
| 自绘组件 | https://github.com/egoist/mygo/blob/main/docs/ui/README.md |
| 桌面系统能力 | https://github.com/egoist/mygo/blob/main/docs/native.md |
| 手机 | https://github.com/egoist/mygo/blob/main/docs/mobile/README.md |
| 插件（终端、SQLite、自动化等） | https://github.com/egoist/mygo/blob/main/docs/README.md#official-plugins |
| 命令 | https://github.com/egoist/mygo/blob/main/docs/cli.md |
