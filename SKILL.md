---
name: transcrab
description: 抓取网页内容，执行高质量翻译，并发布到博客（notes.loopwind.com）。用于永久化保存和分享文章。
metadata: {"clawdbot":{"emoji":"📰","requires":{"bins":["node"]}}}
---

# TransCrab

抓取网页 → 翻译 → 发布到 Astro 博客

## Usage

```bash
# 1. 提取内容
{baseDir}/scripts/run-crab.sh <url> [--lang zh]

# 2. 翻译（在当前 Session 完成）
# 使用 AI 模型翻译 content/articles/<slug>/translate.zh.prompt.txt

# 3. 应用翻译
node {baseDir}/scripts/apply-translation.mjs <slug> --lang zh --in <translated_file>

# 4. 构建和部署
cd {baseDir} && npm run build
# 然后推送到 Git 触发 Cloudflare Pages 部署
```

## Notes

- 提取的内容写入 `content/articles/<slug>/source.md`
- 翻译后生成 `content/articles/<slug>/index.zh.md`
- 博客地址: https://notes.loopwind.com
