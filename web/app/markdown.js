// 极简 markdown → HTML。只支持工单里真会用到的语法，先转义再渲染。
// 有意不引第三方库：这个文件就够用，坏了也好改。

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** 只有这些来源的图片会被渲染成 <img>：本地路径、/api 下的附件、https、内联图片。 */
const SAFE_IMG_SRC = /^(https?:\/\/|\/|\.\/|data:image\/(png|jpe?g|gif|webp);base64,)[^\s"'<>]*$/i;

function inline(text) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    // 图片要先于链接处理：![x](y) 里也包含 [x](y)
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, alt, src) =>
      SAFE_IMG_SRC.test(src) ? `<img src="${src}" alt="${alt}" loading="lazy" class="md-img">` : whole,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const isSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
const ITEM = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;

function renderTree(nodes) {
  if (!nodes.length) return '';
  const tag = nodes[0].ordered ? 'ol' : 'ul';
  const items = nodes
    .map((n) => `<li>${n.label}${n.children.length ? renderTree(n.children) : ''}</li>`)
    .join('');
  return `<${tag}>${items}</${tag}>`;
}

/** 把扁平条目按缩进拼成树，再递归渲染。 */
function renderList(items) {
  const root = [];
  const stack = [{ indent: -1, children: root }];
  for (const item of items) {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { label: item.label, ordered: item.ordered, indent: item.indent, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return renderTree(root);
}

const listLabel = (text) => {
  const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
  if (task) {
    return `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ${inline(task[2])}`;
  }
  return inline(text);
};

/** 渲染 markdown；输入会被转义，可安全塞进 innerHTML。 */
export function md(src) {
  return renderLines(esc(String(src ?? '').replace(/\r\n/g, '\n')).split('\n'));
}

// 内部：lines 已经是转义过的（blockquote 递归时不再转义一遍）
function renderLines(lines) {
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      const lang = fence[1] ? ` class="lang-${fence[1]}"` : '';
      html.push(`<pre class="code"><code${lang}>${body.join('\n')}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*&gt;\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      html.push(`<blockquote>${renderLines(body)}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const cells = (row) =>
        row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      html.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    if (ITEM.test(line)) {
      const items = [];
      while (i < lines.length && ITEM.test(lines[i])) {
        const [, spaces, marker, text] = lines[i].match(ITEM);
        items.push({
          indent: spaces.replace(/\t/g, '  ').length,
          ordered: /^\d+\.$/.test(marker),
          label: listLabel(text),
        });
        i += 1;
      }
      html.push(renderList(items));
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|&gt;\s?|([-*+]|\d+\.)\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (!para.length) para.push(lines[i++]);
    html.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }

  return html.join('\n');
}
