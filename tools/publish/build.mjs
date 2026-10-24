#!/usr/bin/env node
// Renders posts/*.md into /thoughts/<slug>/index.html, rebuilds the Thoughts
// list, and rewrites /feed.xml. It writes files only; publishing happens when
// Scott merges the pull request the GitHub Action opens.
//
// A post publishes when its front matter says
//   status: published                      (now), or
//   status: scheduled  + date on or before today (America/New_York).
// Anything else (draft, missing status) is skipped.
//
// Usage:  node build.mjs            build
//         node build.mjs --dry-run  list what would publish; write nothing

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import { markedSmartypants } from 'marked-smartypants';
import { smartypantsu } from 'smartypants';

const SITE = 'https://scottmcevoy.com';
const TZ = 'America/New_York';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POSTS_DIR = path.join(ROOT, 'posts');
const THOUGHTS_DIR = path.join(ROOT, 'thoughts');
const MANIFEST = path.join(THOUGHTS_DIR, '.published.json');
const DRY = process.argv.includes('--dry-run');

const marked = new Marked()
  .use(markedSmartypants({ config: 1 })) // -- becomes an em dash
  .use(markedFootnote({ description: 'Notes', refMarkers: false }));

// ---------- helpers ----------

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD

// gray-matter turns `date: 2026-11-02` into a Date at UTC midnight; keep it a plain string.
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

const fmtLong = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtShort = (iso) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const rfc822 = (iso) => new Date(`${iso}T12:00:00Z`).toUTCString();

const slugify = (s) =>
  s.toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------- load posts ----------

async function loadPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md');
  const today = todayET();
  const posts = [];

  for (const file of files) {
    const { data, content } = matter(await readFile(path.join(POSTS_DIR, file), 'utf8'));
    const status = String(data.status ?? 'draft').toLowerCase();
    const date = isoDate(data.date);
    const slug = data.slug ? slugify(String(data.slug)) : slugify(file);

    if (!['draft', 'scheduled', 'published'].includes(status)) fail(`${file}: status must be draft, scheduled, or published`);
    if (status !== 'draft') {
      if (!data.title) fail(`${file}: missing title`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${file}: date must be YYYY-MM-DD`);
    }

    const live = status === 'published' || (status === 'scheduled' && date <= today);
    // Curl quotes and dashes in title and dek too (Unicode, so esc() leaves them alone).
    const curl = (t) => (t ? smartypantsu(String(t), 1) : '');
    posts.push({ file, slug, status, date, live, title: curl(data.title), dek: curl(data.dek), body: content });
  }

  const slugs = posts.filter((p) => p.live).map((p) => p.slug);
  const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
  if (dupe) fail(`two live posts share the slug "${dupe}"`);

  return posts.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}

// ---------- page shell, borrowed from the live Thoughts page ----------

// The shell is read from thoughts/index.html, so header, nav, footer, CSP and
// the stylesheet cache-buster stay in step with the rest of the site.
async function loadShell() {
  const html = await readFile(path.join(THOUGHTS_DIR, 'index.html'), 'utf8');
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>') + '</main>'.length;
  if (start < 0 || end < 7) fail('thoughts/index.html has no <main> element to replace');
  return { head: html.slice(0, start), tail: html.slice(end) };
}

function withMeta(head, { title, description, url, type = 'website' }) {
  return head
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)} · Scott McEvoy</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${esc(description)}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${esc(title)}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${esc(description)}`)
    .replace(/(<meta property="og:url" content=")[^"]*/, `$1${url}`)
    .replace(/(<link rel="canonical" href=")[^"]*/, `$1${url}`)
    .replace(/(<meta property="og:url"[^>]*>)/, (m) =>
      /og:type/.test(head) ? m : `${m}\n<meta property="og:type" content="${type}">`);
}

// ---------- renderers ----------

function postPage(shell, p) {
  const url = `${SITE}/thoughts/${p.slug}/`;
  const head = withMeta(shell.head, { title: p.title, description: p.dek || p.title, url, type: 'article' });
  const main = `<main id="main" class="page page-thoughts page-post">
  <header class="page-head">
    <h1>${esc(p.title)}</h1>
    ${p.dek ? `<p class="dek">${esc(p.dek)}</p>` : ''}
  </header>
  <article class="prose">
    <time class="when" datetime="${p.date}">${fmtLong(p.date)}</time>
${marked.parse(p.body).trim()}
  </article>
  <p class="aside-link"><a href="/thoughts/">All thoughts</a></p>
</main>`;
  return head + main + shell.tail;
}

function indexPage(shell, live, originalMain) {
  // Keep the page head (big number, h1, dek) exactly as Scott wrote it.
  const pageHead = originalMain.match(/<header class="page-head">[\s\S]*?<\/header>/)?.[0] ?? '';
  const list = live.length
    ? `<ul class="ledger" role="list">
${live
  .map(
    (p) => `    <li><a class="row-link" href="/thoughts/${p.slug}/"><span class="item-title">${esc(p.title)}</span>${
      p.dek ? `<span class="summary">${esc(p.dek)}</span>` : ''
    }</a><time class="when" datetime="${p.date}">${fmtShort(p.date)}</time></li>`
  )
  .join('\n')}
  </ul>`
    : '<p class="empty">First post in draft.</p>';
  return `${shell.head}<main id="main" class="page page-thoughts">
  ${pageHead}
  ${list}
  <p class="aside-link"><a href="/feed.xml">Follow by RSS</a></p>
</main>${shell.tail}`;
}

function feed(live) {
  const items = live
    .slice(0, 20)
    .map((p) => {
      const url = `${SITE}/thoughts/${p.slug}/`;
      return `  <item>
    <title>${esc(p.title)}</title>
    <link>${url}</link>
    <guid isPermaLink="true">${url}</guid>
    <pubDate>${rfc822(p.date)}</pubDate>
    <description>${esc(p.dek || '')}</description>
    <content:encoded><![CDATA[${marked.parse(p.body).replace(/]]>/g, ']]]]><![CDATA[>')}]]></content:encoded>
  </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>Scott McEvoy: Thoughts</title>
  <link>${SITE}/thoughts/</link>
  <description>Scott McEvoy creates things, helps others create things, and thinks about who owns what they make.</description>
  <language>en</language>
${items}
</channel>
</rss>
`;
}

// ---------- main ----------

const posts = await loadPosts();
const live = posts.filter((p) => p.live);
const waiting = posts.filter((p) => !p.live);

console.log(`Today (ET): ${todayET()}`);
for (const p of live) console.log(`  live       ${p.date}  ${p.slug}`);
for (const p of waiting) console.log(`  ${p.status.padEnd(10)} ${p.date || '—'.padEnd(10)}  ${p.slug}`);
if (DRY) process.exit(0);

const shell = await loadShell();
const originalIndex = await readFile(path.join(THOUGHTS_DIR, 'index.html'), 'utf8');
const originalMain = originalIndex.slice(originalIndex.indexOf('<main'), originalIndex.indexOf('</main>'));

// Remove pages for posts that were live before but no longer are (unpublished,
// renamed, or set back to draft). Only directories this tool created are touched.
const previously = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : [];
for (const slug of previously) {
  if (!live.some((p) => p.slug === slug)) {
    await rm(path.join(THOUGHTS_DIR, slug), { recursive: true, force: true });
    console.log(`  removed    ${slug}`);
  }
}

for (const p of live) {
  const dir = path.join(THOUGHTS_DIR, p.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), postPage(shell, p));
}
await writeFile(path.join(THOUGHTS_DIR, 'index.html'), indexPage(shell, live, originalMain));
await writeFile(path.join(ROOT, 'feed.xml'), feed(live));
await writeFile(MANIFEST, JSON.stringify(live.map((p) => p.slug), null, 2) + '\n');

console.log(`✓ ${live.length} post(s) built.`);
