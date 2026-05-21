# reading_cx

超星学习通阅读助手 —— 自动滚动刷阅读时长的 Tampermonkey 用户脚本。

支持后台运行、自动加载更多、自动翻页/翻章，最后一章后循环回到第一章继续刷；翻页重载后状态自动续传。

## 适配范围

```
https://mooc1.chaoxing.com/mooc-ans/ztnodedetailcontroller/visitnodedetail*
https://mooc1.chaoxing.com/mooc-ans/zt/portal/*
```

入口页（portal）会自动跳到第一章再开始刷。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 新建脚本，将 [reading_cx.js](reading_cx.js) 全文粘贴进去，保存。
3. 打开任意章节阅读页或课程入口页，右上角会浮出控制面板。

## 使用

| 控件 | 说明 |
| --- | --- |
| 目标时长 | 想刷的分钟数，默认 30 分钟，输入后自动持久化 |
| 开始 / 暂停 | 启动或暂停自动刷时长 |
| 重置 | 清零已用时长、页数和持久化状态 |
| ─ | 收起 / 展开面板 |

面板会实时显示运行状态、进度百分比、已用 / 剩余时长、累计翻页数。达到目标时长后自动停止。

## 工作机制

- **后台运行**：劫持 `document.hidden` / `visibilityState`，并用 Web Worker 发送 500ms 心跳，规避后台 Tab 的 `setTimeout` 节流，切到其他标签页也能继续刷。
- **自适应滚动**：自动识别真正的滚动主体（主窗口 / iframe / `overflow:auto` 容器），避免 `window.scrollBy` 打空。
- **拟人行为**：滚动幅度随机化，间歇性派发 `mousemove` 事件。
- **多级翻页兜底**：`a.nodeItem` 精准匹配 → 文字匹配（下一页 / 下一节 / 下一章 / 下一篇）→ 左侧目录下一项 → 已是最后一章则循环回到第一章。
- **加载更多**：接近底部时优先点击 `#loadbutton` 或文案为「加载更多 / 展开更多 / 查看更多」的元素。
- **状态续传**：每轮循环把 `isRunning` / `elapsedMs` / `currentPage` 写入 `localStorage`，30 分钟内的存档在翻页重载后自动恢复。

## 注意

- 仅用于学习交流，请自行评估账号风险。
- 后台运行依赖浏览器对 Web Worker 的支持；若失败会回退到前台 `setInterval(800ms)` 驱动。
- 跨域 iframe 无法访问其内容，此时面板只能依赖主文档的结构，部分课程可能识别不到「下一页」按钮。
