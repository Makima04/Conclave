# 测试卡片集（fixtures）

本目录存放用于角色卡渲染回归测试的问题卡片，每张卡对应一个子目录。

## 约定

```
cards/
  {card-slug}/           # 英文短标识
    *.png 或 *.json      # 原始卡片文件（ST 格式，含嵌入 JSON 元数据）
    expectations.md      # 预期行为描述（回归验收标准）
```

## 现有卡片

| slug | 卡名 | 文件 | 已知问题 |
|------|------|------|---------|
| `cangxuanjie` | 苍玄界 | `3.X.png` | 浮动"灵"按钮消失（脚本库宿主错位） |
| `bianshenshaonv` | 变身少女的绝对隶属调教日记 | `-7.png` | 待回归验证 |
| `lurenunzhu` | 路人女主的养成方法测试版 v0.09 | `v0.09.png` | 待回归验证 |
| `dahuangz` | 大荒 z | `z_30.png` | 待回归验证 |

## 使用方式

- **CardRenderLab**（`/lab`）：开发环境页面，列出所有 fixture 卡，渲染开场白并捕获 console error。
- **验收流程**：每个里程碑完成后，逐卡检查 expectations.md 中的条目。

## 添加新卡片

1. 卡片 PNG/JSON 放入 `cards/{slug}/`。
2. 写 `expectations.md`，列出预期行为（开场白渲染 / 交互按钮 / 变量 / 浮动 UI / swipe / 样式等）。
3. 在 CardRenderLab 中验证。
