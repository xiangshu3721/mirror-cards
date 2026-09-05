# 镜像卡牌 · Mirror Cards

Mobile-First 静态网页：69 张「镜像卡」抽牌体验，用于照镜子式深度觉察。

纯 Vanilla HTML / CSS / JS，无后端、无构建步骤。

## 本地预览

```bash
cd /workspace/mirror-cards
python3 -m http.server 8877
```

浏览器打开：http://127.0.0.1:8877/

> 因使用 ES modules，请务必通过 HTTP 服务打开，不要直接用 `file://`。

## 流程

首页 → 选张数（1 / 3 / 5 / 9 / 自定义 1–69）→ 选牌阵 → 洗牌抽取 → 点按翻转 → 详情引导提问 → 再抽一次

## 替换 69 张卡面图

默认卡面为优雅数字占位（编号 + 金色圆环）。若要换成真实图片：

1. 将图片放入 `images/` 目录
2. 按命名约定：

```
images/card-01.webp
images/card-02.webp
…
images/card-69.webp
```

3. 编号必须两位、从 `01` 到 `69`，扩展名 `.webp`（与 `js/deck.js` 中 `image` 字段一致）
4. 建议竖版比例约 **76:126**（与 CSS `--card-ratio` 一致），体积尽量小以便移动端加载
5. 有图则自动显示图片；缺失则继续显示数字占位面——无需改代码

可选：同步修改 `js/deck.js` 里的 `name`、`prompt` 文案。

## 目录

```
mirror-cards/
├── index.html
├── css/app.css
├── js/
│   ├── app.js        # 流程与交互
│   ├── deck.js       # 69 张占位卡数据
│   └── spreads.js    # 牌阵与引导提问
├── images/           # card-01.webp … card-69.webp（可选）
├── README.md
└── ACCEPTANCE.md
```

## 设计说明

- 背景 `#12161d` / `#171d26`，奶油字 `#f2ece1`，金色强调 `#d4af78` 等
- 标题宋体栈（Songti SC / Noto Serif SC），正文 PingFang / 系统 UI
- 卡背为 CSS 几何金线纹，未使用第三方卡面素材
- `theme-color: #12161d`；不引入 Google Fonts CDN

## 边界

本应用仅用于自我觉察与反思练习，不是医学诊断、心理治疗或危机干预工具。
