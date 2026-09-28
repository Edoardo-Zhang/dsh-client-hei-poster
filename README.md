# dsh-client-hei-poster

DSH 桌面版启动封面插件：启动应用、或从托盘重新打开窗口时，用一张全屏「罗小黑战记」海报盖住界面。
**只有点击右下角的「聊天窗口」入口才能进入正常界面**，点海报其他任何位置都没有反应。

## 行为规格

| 项目 | 行为 |
|---|---|
| 显示时机 | ① 应用启动 ② 窗口从托盘/最小化恢复（hidden -> visible 边沿） |
| 不显示时机 | 单纯 alt-tab 切走再切回、页面一直可见时的 focus 变化 |
| 关闭方式 | **只认**右下角聊天窗口控件被点击（或键盘 Enter/Space 激活它） |
| 兜底 1 | 按 Esc 关闭 |
| 兜底 2 | 每次显示 30 秒后自动关闭 |
| 兜底 3 | Console 禁用开关（见下） |
| 海报轮换 | **每次显示都换另一张**（A -> B -> A ...），索引用 localStorage 持久化 |
| 输入武装 | 显示后 250ms 内的点击被忽略，避免窗口刚弹出的误触立刻关掉 |
| 铺满方式 | object-fit: cover（1280x800 下上下各裁约 33 原始像素，片名与题词已实测保住） |

## 三张海报怎么换

> 仓库里自带的两张海报是 **AI 生成的素材**，只为让插件开箱可跑；换成你自己的图即可。


素材在 assets/poster-a.png 与 assets/poster-b.png（1536x1024，PNG）。
**替换真素材时只需覆盖这两个同名文件，不需要改代码、不需要重新构建。**

轮换顺序：首次运行显示 A；之后每次封面出现都前进一张，用 localStorage 的 hei.posterIndex 记住上次显示的是哪张。
清掉这个键（`localStorage.removeItem("hei.posterIndex")`）就会从 A 重新开始。

## 遇到问题怎么关掉封面

按顺序试：

1. **点右下角聊天窗口**（正常入口）
2. 按 **Esc**
3. 等 **30 秒**自动关闭
4. Console 里执行，之后封面不再出现：

       window.__HEI_POSTER_DISABLE__ = true; window.__HEI_POSTER__?.dismiss("escape")

5. 永久关闭：

       localStorage.setItem("hei.noPoster", "1")

   恢复：`localStorage.removeItem("hei.noPoster")`

6. 给 <html> 加属性 `data-hei-off` 也能关闭（DevTools 里改，持久）

## 确认插件加载了

F12 打开 Console：

    document.querySelector("#hei-poster-overlay")        // 应返回一个 div
    getComputedStyle(document.querySelector("#hei-poster-overlay")).zIndex   // 应为 "2000"
    window.__HEI_POSTER__                                  // 调试句柄，可看 controller / posters

手动切换看某一张：`window.__HEI_POSTER__.showPoster(1)`

## 自检

在工作区目录 D:/X Files/DSH/dsh01/_hei-poster/plugin 下：

    node --check src/index.js           # 宿主半边语法
    node --test src/client/overlay.test.ts   # 状态机 15 项单测
    node scripts/selfcheck-host.mjs     # 宿主路由 38 项（白名单/Range/ETag/逃逸）
    node scripts/selfcheck-client.mjs   # 客户端 36 项，在真实无头 Edge 里跑真产物
    node scripts/build-client.mjs       # 重建 lib/client.js

`selfcheck-client.mjs` 需要本机有 Edge；它会在内存里起一个静态服务，把 /plugins/<id>/assets/ 映射到真实素材，
然后断言热区门禁（点海报不关、点入口才关）、轮换、武装延迟、禁用开关、Esc、teardown 与零 console.error。

## 设计约束（不要动）

- 客户端半边 `export const inject = []`：只用 DOM，不读任何服务，从根上避开
  "cannot get property X without inject" 这条最常见的插件半失效死法。
- 产物 `lib/client.js` 的 `require()` 清单为**空**——不依赖宿主任何外部模块。
  一旦新增 import，必须确认目标在宿主 staticModules seed 表里（当前是 react / react/jsx-runtime /
  react-dom / react-dom/client / @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
  dsh-client-ui-primitives / dsh-client-ui-dockkit 九个），否则浏览器里会直接抛异常、封面不出现。
- 浮层挂在 document.body 下、#root 的同级兄弟，z-index 2000（宿主最大 1100）。
- **绝不写 <html> 背景**：宿主主题已保证 body 不透明，而内联的 html 背景会在 macOS vibrancy 下把窗口刷黑且无法恢复。
- `apply()` 第一句就注册 ctx.effect teardown（可变 ref 后装实现），保证半成品也能被清理。
- 我们的 CSS 只注入 shadow root，绝不进 document.head，避免污染宿主 UI。
- 无任何第三方运行时依赖，不会遮蔽 profile 里 hoisted 的宿主依赖。

## 安装位置

    <你的 .dsh 目录>\profiles\desktop\node_modules\dsh-client-hei-poster
    （Windows 上默认是 %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-client-hei-poster）

profile 的 package.json 里 `dependencies` 与 `dsh.profile.bundles` **两者都必须有**，缺一不加载。
用桌面版自带 pnpm（resources/runtime/pnpm/bin/pnpm.mjs，v11.7.0）安装，**不要**用全局 pnpm。
