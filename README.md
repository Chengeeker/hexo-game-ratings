# Hexo Game Ratings

[简体中文](#中文使用说明) · [English](#english)

A lightweight open-source Hexo plugin that generates player-rating cards for **Steam**, **Epic Games Store** and **Xbox**. Works especially well with Butterfly, but does not require editing a theme.

> The plugin is independent of the author's game site. No private API tokens or game content are bundled.

## 中文使用说明

### 功能

- **Steam**：从文章内 Steam 商店链接提取 AppID，构建时获取 Steam 官方好评/差评数据、好评率，展示明确标注为「参考估算」的 10 分制口碑分（不是 Steam 官方评分）。
- **Xbox**：从官方商店商品页 JSON-LD 提取五星平均分和评价数量。
- **Epic Games**：自动发现商品链接，在 `hexo generate` 时尝试通过外部公开网页文本获取官方五星玩家评分。已获取的分数写入本地快照；访问受限、无评分或失败时保留旧值，不阻止构建。
- 自动在文章**第一个 Markdown `##` 二级标题之后**、其余正文之前插入卡片。无 `##` 时回退到正文开头。
- 适配深色模式和手机布局；CSS 由插件自动生成并注入，无需修改主题文件。
- 不为哔哩哔哩等其他商店生成评分。默认没有可识别商店链接时不显示占位卡。

### 安装

要求 Node.js 18+、Hexo 7+。在 Hexo 站点目录执行：

```bash
npm install --save "git+https://github.com/Chengeeker/hexo-game-ratings.git#v0.1.0"
npx hexo clean
npx hexo generate
```

**npm 12+** 默认禁止安装 Git 依赖，需要使用 `--allow-git=root` 允许项目明确声明的 Git 依赖：

```bash
npm install --save "git+https://github.com/Chengeeker/hexo-game-ratings.git#v0.1.0" --allow-git=root
```

为了使今后的 `npm ci` 等安装命令也可以正常工作，可以在你的网站根目录 `.npmrc` 中添加 `allow-git=root`。这只允许项目直接列出的 Git 依赖，**不需要**设置 `allow-git=all`。如已有其他 Hexo 插件的 peer dependency 版本冲突，需单独处理其兼容性。插件目前直接在 GitHub 开源，尚未发布到 npm 注册表。

直接在游戏文章添加平台链接（包含 Butterfly 的 `{% btn ... %}` 链接也可以）：

```markdown
---
title: Example Game
categories:
  - 游戏
---

## Example Game v1.0

游戏简介……

[Steam](https://store.steampowered.com/app/1086940/)
```

你也可以在 front-matter 使用 `steam_appid: 1086940` 指定 Steam AppID。

### 可选配置（站点 `_config.yml`）

```yaml
game_ratings:
  categories:
    - 游戏
    - Games
  show_unlinked: false
  epic:
    auto_refresh: true
    max_requests_per_build: 3
    refresh_days: 14
    missing_retry_days: 2
    timeout_ms: 14000
```

`show_unlinked: true` 会在游戏文章没有任何可识别商店链接时显示「未关联 Steam AppID」的简短占位卡；哔哩哔哩链接不会生成该占位卡。

`game_ratings: true` 或 `game_ratings: false` 可以在单篇文章 front-matter 中强制显示/禁用自动处理。

### Epic 全自动工作机制与限制

**不需要手动运行额外脚本。** 每次 `hexo generate`（包括站点的 Cloudflare Pages 部署命令）时，插件会自动扫描新增 Epic 商品链接；一次构建默认最多检查 3 款游戏，定期刷新旧评分，同时记录失败重试时间，避免每次构建重复请求相同的无评分页面。

获取方式是 Jina Reader 的公开网页**纯文本**读取接口，仅解析 Epic 明确标记为 `Epic Player Ratings` 的五星玩家评分。不解析年龄分级、价格或媒体分数；不伪造登录状态，不收集出生日期，不使用 Epic Cookie。第三方服务可能返回 401、403、429、年龄确认页或不含评分的文本，此时**不能保证拿到新游戏的评分**，但 Hexo 仍会继续构建并显示现有快照或「暂无可核实评分」。

如需提高外部读取成功率，可以在构建环境配置 Jina Reader 的 `JINA_API_KEY` 环境变量；**不要**把密钥写入 `_config.yml`、源码或 GitHub。此插件不会将私密登录信息发往外部服务。

缓存位置：

- `.cache/steam-reviews.json`：Steam（默认 12 小时有效）
- `.cache/xbox-reviews.json`：Xbox（默认 24 小时有效）
- `.cache/hexo-game-ratings-epic-attempts.json`：Epic 的查询冷却记录
- `source/_data/epic-ratings.json`：Epic 官方评分记录（含来源地址与更新时间），建议作为站点内容备份

可使用 Hexo 的常规部署流程：

```bash
npx hexo clean && npx hexo generate && npx wrangler pages deploy public --project-name YOUR_PROJECT
```

**注意**：`hexo clean` 只清理生成目录，Epic 评分持久化文件不受影响。要在 CI 中保留历史评分，请将站点的 `source/_data/epic-ratings.json` 纳入版本管理或其他持久存储；纯临时 CI 环境中新增评分如果没有保存回仓库，下一次构建仍需重新请求。

### 数据口径

- Steam：好评率和评价数量来自 Steam 官方 API；10 分制分数由插件根据 `(好评数+2100)/(总评价数+4200)` 估算，**非 Steam 官方 10 分制评分**。
- Xbox：来自 Xbox 商店商品页的五星制 `aggregateRating`。
- Epic：公开商品页中的官方玩家五星评分；第三方公开网页读取不等于 Epic 官方提供的稳定评分 API。
- 以上评分制度不同，不能直接把不同平台的数值当作同一标准比较。

### 开发

```bash
npm test
npm run check
```

使用 MIT License。欢迎 Issue 和 Pull Request。

---

## English

Hexo Game Ratings automatically inserts review cards after the first H2 heading in game posts. It supports Steam review statistics, Xbox store ratings, and best-effort automatic discovery of public Epic Games star ratings during every Hexo build.

Install from the pinned GitHub release with `npm install --save "git+https://github.com/Chengeeker/hexo-game-ratings.git#v0.1.0"`. npm 12+ additionally needs `--allow-git=root` (or `allow-git=root` in your site's `.npmrc`). Configure categories and Epic refresh behavior using the `game_ratings` options shown above.

**Important:** Epic scraping is best-effort, may fail due to access controls or age gates, and never invents missing ratings. Existing cached ratings are preserved. The plugin contains no credentials and does not bypass account authentication.

MIT © 2026 Chengeeker.
