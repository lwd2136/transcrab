#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import matter from 'gray-matter';
import slugify from 'slugify';
import { fetch, ProxyAgent } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CONTENT_ROOT = process.env.TRANSCRAB_CONTENT_ROOT
  ? path.resolve(process.env.TRANSCRAB_CONTENT_ROOT)
  : path.join(ROOT, 'content', 'articles');

function usage() {
  console.log(`Usage:
  node scripts/add-url.mjs <url> [--lang zh]

Notes:
  - Fetches HTML, extracts main article (Readability), converts to Markdown (Turndown)
  - Writes source.md + meta.json
  - Generates a translation prompt for the running OpenClaw assistant (does NOT call OpenClaw)
`);
}

function argValue(args, key, def = null) {
  const idx = args.indexOf(key);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return def;
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(args.length === 0 ? 2 : 0);
}

const url = args[0];
const lang = argValue(args, '--lang', 'zh');

await fs.mkdir(CONTENT_ROOT, { recursive: true });

const normalizedSourceUrl = normalizeSourceUrl(url);
const existing = await findExistingArticleBySourceUrl(normalizedSourceUrl);
if (existing) {
  const sourcePath = path.join(existing.dir, 'source.md');
  const sourceRaw = await fs.readFile(sourcePath, 'utf-8');
  const parsed = matter(sourceRaw);
  const markdown = String(parsed.content || '').trim() + '\n';

  const prompt = buildTranslatePrompt(markdown, lang);
  const promptPath = path.join(existing.dir, `translate.${lang}.prompt.txt`);
  await fs.writeFile(promptPath, prompt + '\n', 'utf-8');

  console.log(
    JSON.stringify(
      {
        ok: true,
        slug: existing.slug,
        dir: existing.dir,
        lang,
        promptPath,
        date: existing.meta?.date || new Date().toISOString(),
        idempotent: true,
        reused: true,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const html = await fetchHtml(url);
const paywall = detectPaywall(html, url);
if (false && paywall.blocked) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: 'PAYWALL_DETECTED',
        message: 'Paywall detected. Task aborted.',
        reason: paywall.reason,
        sourceUrl: normalizedSourceUrl,
      },
      null,
      2,
    ),
  );
  process.exit(3);
}

const { title, markdown } = await htmlToMarkdown(html, url);
const baseSlug = makeSlug(title || url);
const { slug, dir } = await makeUniqueSlugDir(baseSlug);

const now = new Date();
const date = now.toISOString();

const sourceFrontmatter = {
  title: title || slug,
  date,
  sourceUrl: normalizedSourceUrl,
  lang: 'source',
};
const sourceMd = matter.stringify(markdown, sourceFrontmatter);
await fs.writeFile(path.join(dir, 'source.md'), sourceMd, 'utf-8');

const meta = {
  slug,
  title: title || slug,
  date,
  sourceUrl: normalizedSourceUrl,
  targetLang: lang,
};
await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf-8');

const prompt = buildTranslatePrompt(markdown, lang);
const promptPath = path.join(dir, `translate.${lang}.prompt.txt`);
await fs.writeFile(promptPath, prompt + '\n', 'utf-8');

// Print a machine-readable summary for wrappers.
console.log(JSON.stringify({ ok: true, slug, dir, lang, promptPath, date }, null, 2));

// Ensure the CLI exits even if HTTP keep-alive leaves sockets open (e.g. in tests/local servers).
process.exit(0);

// ----------------

async function fetchHtml(url) {
  const proxyUrl = process.env.TRANSCRAB_PROXY;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  const res = await fetch(url, {
    redirect: 'follow',
    dispatcher,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function htmlToMarkdown(html, baseUrl) {
  // Lazy-load JSDOM (heavy)
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(html, { url: baseUrl });

  // --- Preserve code block language before Readability ---
  // Many docs sites keep language info in wrapper classes:
  //   <div class="language-csharp ext-cs ..."><pre class="language-csharp"><code>...</code></pre>...
  // Readability may strip those classes. We'll capture language hints first and
  // re-attach them after extraction by matching code text prefixes.
  const langHints = collectCodeLangHints(dom.window.document);

  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const title = article?.title || dom.window.document.title || '';
  const contentHtml = article?.content || dom.window.document.body?.innerHTML || '';

  // Re-attach language hints (best-effort).
  const contentDom = new JSDOM(contentHtml, { url: baseUrl });
  applyCodeLangHints(contentDom.window.document, langHints);
  const patchedHtml = contentDom.window.document.body?.innerHTML || contentHtml;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });

  // Track guessed/explicit languages while converting.
  // We'll use it to set a page-level default language for code fences that have no info string.
  const fenceLangCounts = new Map();
  const bump = (lang) => {
    if (!lang) return;
    fenceLangCounts.set(lang, (fenceLangCounts.get(lang) || 0) + 1);
  };

  // Preserve language info for fenced code blocks when possible.
  // Many docs sites render code blocks like:
  //   <pre class="language-csharp"><code>...</code></pre>
  // or wrap them with a div like:
  //   <div class="language-csharp ext-cs"><pre>...</pre></div>
  // Readability may rewrite some wrappers, so we check multiple places.
  turndown.addRule('fencedCodeBlockWithLanguage', {
    filter(node) {
      return (
        node.nodeName === 'PRE' &&
        node.textContent &&
        node.textContent.trim().length > 0
      );
    },
    replacement(_content, node) {
      const pre = node;
      const codeEl = pre.querySelector?.('code') || null;

      const classSources = [
        pre.getAttribute?.('class') || '',
        codeEl?.getAttribute?.('class') || '',
        pre.parentElement?.getAttribute?.('class') || '',
      ].filter(Boolean);

      function pickLang(classes) {
        const joined = classes.join(' ');
        // Common: language-xxx / lang-xxx
        let m = joined.match(/\b(?:language|lang)-([a-z0-9_+-]+)\b/i);
        if (m) return normalizeLang(m[1]);
        // Some sites: ext-cs, ext-js, etc.
        m = joined.match(/\bext-([a-z0-9_+-]+)\b/i);
        if (m) return normalizeLang(m[1]);
        return null;
      }

      function normalizeLang(lang) {
        const l = String(lang).toLowerCase();
        // A few pragmatic aliases seen on docs sites.
        if (l === 'cs') return 'csharp';
        if (l === 'c#') return 'csharp';
        if (l === 'js') return 'javascript';
        if (l === 'ts') return 'typescript';
        if (l === 'sh') return 'bash';
        if (l === 'shell') return 'bash';
        if (l === 'py') return 'python';
        if (l === 'kt') return 'kotlin';
        return l;
      }

      let lang = pickLang(classSources);
      const raw = (codeEl ? codeEl.textContent : pre.textContent) || '';
      const text = raw.replace(/\n+$/g, '');

      // If we cannot extract any explicit language info, try a conservative heuristic.
      // This is ONLY a fallback when there are no language tags.
      if (!lang) lang = guessLangFromCode(text);

      bump(lang);

      const fence = '```';
      const info = lang ? lang : '';
      return `\n${fence}${info}\n${text}\n${fence}\n`;
    },
  });

  // Keep links and images as-is
  let md = turndown.turndown(patchedHtml);

  // If most code blocks are the same language and some fences are missing info strings,
  // apply a page-level default language to those empty fences.
  const defaultFenceLang = pickDefaultFenceLang(fenceLangCounts);
  if (defaultFenceLang) {
    md = applyDefaultLangToFences(md, defaultFenceLang);
  }

  return { title: title.trim(), markdown: md.trim() + '\n' };
}

function pickDefaultFenceLang(counts) {
  const entries = [...(counts || new Map()).entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const [bestLang, bestCount] = entries[0];
  const secondCount = entries[1]?.[1] ?? 0;

  // Be conservative: only set a default when one language clearly dominates.
  // This matches the user's expectation that a post is usually written in one language.
  if (bestCount < 2) return null;
  if (bestCount / Math.max(1, total) < 0.6) return null;
  if (bestCount - secondCount < 2 && bestCount < 6) return null;

  return bestLang;
}

function applyDefaultLangToFences(md, lang) {
  const lines = String(md || '').split(/\r?\n/);
  let inFence = false;
  let fenceToken = '```';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(```+)(.*)$/);
    if (!m) continue;

    const token = m[1];
    const info = (m[2] || '').trim();

    if (!inFence) {
      // opening fence
      inFence = true;
      fenceToken = token;
      if (!info) lines[i] = `${token}${lang}`;
    } else {
      // closing fence (match same token length)
      if (token === fenceToken) {
        inFence = false;
        fenceToken = '```';
      }
    }
  }

  return lines.join('\n');
}

function normalizeLangHint(lang) {
  const l = String(lang || '').toLowerCase();
  if (!l) return null;
  if (l === 'cs' || l === 'c#') return 'csharp';
  if (l === 'js') return 'javascript';
  if (l === 'ts') return 'typescript';
  if (l === 'sh' || l === 'shell') return 'bash';
  if (l === 'py') return 'python';
  if (l === 'kt') return 'kotlin';
  return l;
}

// Conservative language guessing for code blocks when the source HTML provides no language tags.
// Returns a highlight.js-compatible language id (e.g. "javascript", "tsx"), or null.
function guessLangFromCode(code) {
  const s = String(code || '');
  const t = s.trim();
  if (!t) return null;

  // Early: shebangs
  if (/^#!\/(usr\/bin\/env\s+)?(bash|sh)\b/m.test(t)) return 'bash';
  if (/^#!\/(usr\/bin\/env\s+)?python\b/m.test(t)) return 'python';
  if (/^#!\/(usr\/bin\/env\s+)?node\b/m.test(t)) return 'javascript';

  // Helper: score by strong signals. Keep this conservative to avoid random guesses.
  const scores = new Map();
  const add = (lang, n) => scores.set(lang, (scores.get(lang) || 0) + n);

  // JS / TS / JSX / TSX
  if (/\b(useState|useEffect|useMemo|useCallback|useRef|createContext)\s*\(/.test(t)) add('javascript', 3);
  if (/\b(import|export)\b/.test(t) && /\bfrom\b/.test(t)) add('javascript', 2);
  if (/\bmodule\.exports\b|\brequire\s*\(/.test(t)) add('javascript', 2);
  if (/\bfunction\b\s+[A-Za-z0-9_]+\s*\(/.test(t) && /\bconst\b|\blet\b/.test(t)) add('javascript', 1);
  // JSX-ish
  if (/\breturn\s*\(<[A-Za-z]/.test(t) || /<[A-Za-z][^>]*>/.test(t)) add('jsx', 4);
  // TS-ish
  if (/\b(interface|type)\s+[A-Za-z0-9_]+\s*=/.test(t)) add('typescript', 4);
  if (/\binterface\s+[A-Za-z0-9_]+\b/.test(t)) add('typescript', 4);
  if (/\b(as\s+const|satisfies)\b/.test(t)) add('typescript', 3);
  if (/\b(enum)\s+[A-Za-z0-9_]+\b/.test(t)) add('typescript', 2);
  // Type annotations like: foo: string, (x: Foo) =>
  if (/(^|[\(,])\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*[A-Za-z_][A-Za-z0-9_<>\[\]\|& ]{0,60}/.test(t)) add('typescript', 2);

  // If JSX and TS both present, assume TSX.
  if ((scores.get('jsx') || 0) >= 4 && (scores.get('typescript') || 0) >= 3) {
    add('tsx', 6);
  }

  // Python
  if (/^\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/m.test(t)) add('python', 4);
  if (/^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\s*\(?/m.test(t) && /:\s*$/m.test(t)) add('python', 2);
  if (/\b(self|None|elif|yield)\b/.test(t)) add('python', 2);

  // Bash / shell
  if (/^\s*(set -e|set -euxo pipefail)\b/m.test(t)) add('bash', 3);
  if (/\b(echo|grep|sed|awk|curl|chmod|chown)\b/.test(t) && /\n/.test(t)) add('bash', 2);
  if (/\b(fi|then|elif)\b/.test(t) && /\bif\b/.test(t)) add('bash', 1);

  // Go
  if (/^\s*package\s+\w+/m.test(t) && /^\s*func\s+\w+\s*\(/m.test(t)) add('go', 5);
  if (/\b:=\b/.test(t) && /\bfmt\./.test(t)) add('go', 2);

  // Rust
  if (/^\s*fn\s+main\s*\(\)\s*\{/m.test(t) || /\bprintln!\s*!\(/.test(t)) add('rust', 5);
  if (/\buse\s+[a-zA-Z0-9_:]+;/.test(t) && /\blet\s+mut\b/.test(t)) add('rust', 2);

  // Swift
  if (/^\s*import\s+(Foundation|SwiftUI|Combine)\b/m.test(t)) add('swift', 4);
  if (/\b(let|var)\b\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*[A-Za-z_][A-Za-z0-9_<>\[\]\? ]+/.test(t)) add('swift', 2);
  if (/\bfunc\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(t) && /\bguard\b/.test(t)) add('swift', 2);

  // C#
  if (/^\s*using\s+System\b/m.test(t) || /\bnamespace\s+\w+/.test(t)) add('csharp', 4);
  if (/\bpublic\s+(class|struct|interface)\b/.test(t) && /\bget;\s*set;\b/.test(t)) add('csharp', 2);

  // Kotlin
  if (/^\s*(fun|class)\s+\w+/m.test(t) && /\bval\b|\bvar\b/.test(t) && /\bwhen\b/.test(t)) add('kotlin', 4);

  // Choose best only if confidence is high enough.
  const entries = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const [bestLang, bestScore] = entries[0];
  const secondScore = entries[1]?.[1] ?? 0;

  // Thresholds: conservative, but allow very strong single-signal languages.
  // - JSX detection is fairly distinctive (angle-bracket tags / return <...)
  // - Python "def" is also distinctive
  const minScoreByLang = {
    jsx: 4,
    tsx: 6,
    javascript: 4,
    typescript: 4,
    python: 4,
    bash: 4,
    go: 5,
    rust: 5,
    swift: 5,
    csharp: 5,
    kotlin: 5,
  };
  const minScore = minScoreByLang[bestLang] ?? 5;

  if (bestScore < minScore) return null;
  // If the winner is only barely ahead, require higher confidence.
  if (bestScore - secondScore < 2 && bestScore < (minScore + 2)) return null;

  // Collapse jsx/tsx into highlight.js names
  if (bestLang === 'jsx') return 'jsx';
  if (bestLang === 'tsx') return 'tsx';
  if (bestLang === 'typescript') return 'typescript';
  if (bestLang === 'javascript') return 'javascript';
  return bestLang;
}

function detectLangFromClass(className) {
  const c = String(className || '');
  let m = c.match(/\b(?:language|lang)-([a-z0-9_+-]+)\b/i);
  if (m) return normalizeLangHint(m[1]);
  m = c.match(/\bext-([a-z0-9_+-]+)\b/i);
  if (m) return normalizeLangHint(m[1]);
  return null;
}

function codePrefix(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  // Greedy/simple: first 120 chars is enough for matching.
  return t.slice(0, 120);
}

function collectCodeLangHints(doc) {
  const hints = [];
  for (const pre of doc.querySelectorAll('pre')) {
    const codeEl = pre.querySelector('code') || pre;
    const raw = codeEl.textContent || '';
    const prefix = codePrefix(raw);
    if (!prefix) continue;

    const lang =
      detectLangFromClass(pre.getAttribute('class')) ||
      detectLangFromClass(codeEl.getAttribute('class')) ||
      detectLangFromClass(pre.parentElement?.getAttribute('class'));

    if (!lang) continue;

    hints.push({ prefix, lang });
  }

  // If page seems to use a single language overwhelmingly, keep it as default.
  const counts = new Map();
  for (const h of hints) counts.set(h.lang, (counts.get(h.lang) || 0) + 1);
  let defaultLang = null;
  if (counts.size === 1) defaultLang = [...counts.keys()][0];

  return { hints, defaultLang };
}

function applyCodeLangHints(doc, pack) {
  const { hints = [], defaultLang = null } = pack || {};

  // For each <pre>, try to match by prefix; if cannot, fall back to defaultLang.
  for (const pre of doc.querySelectorAll('pre')) {
    const codeEl = pre.querySelector('code') || pre;
    const raw = codeEl.textContent || '';
    const prefix = codePrefix(raw);

    let lang = null;
    if (prefix) {
      // Simple greedy match: first hint whose prefix is contained.
      for (const h of hints) {
        if (prefix === h.prefix || prefix.startsWith(h.prefix) || h.prefix.startsWith(prefix)) {
          lang = h.lang;
          break;
        }
      }
    }

    if (!lang) lang = defaultLang;
    if (!lang) continue;

    // Attach to <pre> so Turndown rules can pick it up.
    const cur = pre.getAttribute('class') || '';
    if (!/\blanguage-/.test(cur)) {
      pre.setAttribute('class', `${cur} language-${lang}`.trim());
    }
  }
}

function makeSlug(title) {
  const s = slugify(title, { lower: true, strict: true, trim: true });
  return s || `article-${Date.now()}`;
}

async function existsDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function makeUniqueSlugDir(baseSlug) {
  let slug = baseSlug;
  let dir = path.join(CONTENT_ROOT, slug);

  if (!(await existsDir(dir))) {
    await fs.mkdir(dir, { recursive: true });
    return { slug, dir };
  }

  // If exists, append -2, -3... to avoid overwriting existing articles.
  for (let i = 2; i < 1000; i++) {
    slug = `${baseSlug}-${i}`;
    dir = path.join(CONTENT_ROOT, slug);
    if (!(await existsDir(dir))) {
      await fs.mkdir(dir, { recursive: true });
      return { slug, dir };
    }
  }

  // Last resort.
  slug = `${baseSlug}-${Date.now()}`;
  dir = path.join(CONTENT_ROOT, slug);
  await fs.mkdir(dir, { recursive: true });
  return { slug, dir };
}

function detectPaywall(html, pageUrl) {
  const raw = String(html || '');
  const lc = raw.toLowerCase();

  const strongSignals = [
    /meteredcontent/i,
    /paywall/i,
    /subscriber-?only/i,
    /subscribe\s+to\s+continue/i,
    /sign\s*in\s+to\s+continue/i,
    /content\s+is\s+for\s+subscribers/i,
    /data-testid=["']paywall/i,
    /class=["'][^"']*(paywall|subscription)[^"']*["']/i,
    /property=["']og:restrictions:age["']/i,
    /name=["']robots["'][^>]*noarchive/i,
  ];

  const softSignals = [
    /you\'ve\s+reached\s+your\s+limit/i,
    /remaining\s+articles/i,
    /become\s+a\s+subscriber/i,
    /unlock\s+this\s+article/i,
    /continue\s+reading\s+with\s+a\s+subscription/i,
  ];

  for (const re of strongSignals) {
    if (re.test(raw)) {
      return { blocked: true, reason: `strong-signal:${re}` };
    }
  }

  let softHits = 0;
  for (const re of softSignals) {
    if (re.test(raw)) softHits += 1;
  }

  // Domain-specific hinting for known metered media.
  const host = (() => {
    try {
      return new URL(pageUrl).hostname;
    } catch {
      return '';
    }
  })();

  const isKnownMeteredHost = /(^|\.)newyorker\.com$/i.test(host) || /(^|\.)nytimes\.com$/i.test(host);
  if (softHits >= 2 && isKnownMeteredHost) {
    return { blocked: true, reason: `metered-host:${host}:soft-hits=${softHits}` };
  }

  return { blocked: false, reason: '' };
}

function normalizeSourceUrl(input) {
  try {
    const u = new URL(String(input || '').trim());
    // Keep origin + path only; ignore query/hash to improve idempotency for tracking params.
    return `${u.origin}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return String(input || '').trim();
  }
}

async function findExistingArticleBySourceUrl(normalizedUrl) {
  let entries = [];
  try {
    entries = await fs.readdir(CONTENT_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CONTENT_ROOT, entry.name);
    const metaPath = path.join(dir, 'meta.json');

    let meta = null;
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      meta = JSON.parse(raw);
    } catch {
      // Ignore malformed/missing meta and continue scanning.
      continue;
    }

    const candidate = normalizeSourceUrl(meta?.sourceUrl || '');
    if (!candidate) continue;

    if (candidate === normalizedUrl) {
      return {
        slug: meta?.slug || entry.name,
        dir,
        meta,
      };
    }
  }

  return null;
}

function buildTranslatePrompt(md, targetLang) {
  return [
    `/no_think 你是一位专业翻译，任务是将《纽约客》的文学和新闻内容翻译成简体中文，仅输出最终结果。请使用精致、智慧、细腻的语言，呈现耐人寻味的情感，保留人名（备注原英文）、缩写和专业术语的准确性，符合中国大陆表达习惯，确保信息准确，分段翻译时参考先前段落保持术语一致。`,
    `翻译步骤：`,
    `1. 翻译成简体中文，确保准确（不输出）。`,
    `2. 调整为流畅表达，体现《纽约客》风格，仅输出此结果。`,
    ``,
    `---`,
    md,
  ].join('\n');
}
