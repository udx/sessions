(function () {
  function createLink(label, value) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      return null;
    }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    const anchor = document.createElement('a');
    anchor.href = url.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer nofollow';
    appendInline(anchor, label || url.href);
    return anchor;
  }

  function appendInline(container, text) {
    const pattern = /(``?[^`]+``?)|(!?\[[^\]]*\]\([^)]+\))|(\*\*\*[^*]+\*\*\*|___[^_]+___)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*)|(~~[^~]+~~)|(https?:\/\/[^\s<]+)/g;
    let lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)));
      const token = match[0];
      if (match[1]) {
        const delimiter = token.startsWith('``') ? '``' : '`';
        const code = document.createElement('code');
        code.textContent = token.slice(delimiter.length, -delimiter.length);
        container.append(code);
      } else if (match[2]) {
        const parts = token.match(/^!?\[([^\]]*)\]\(([^)]+)\)$/);
        const isImage = token.startsWith('!');
        const link = createLink(isImage ? `Image: ${parts[1] || 'attachment'}` : parts[1], parts[2]);
        container.append(link || document.createTextNode(token));
      } else if (match[3]) {
        const strong = document.createElement('strong');
        const emphasis = document.createElement('em');
        appendInline(emphasis, token.slice(3, -3));
        strong.append(emphasis);
        container.append(strong);
      } else if (match[4]) {
        const strong = document.createElement('strong');
        appendInline(strong, token.slice(2, -2));
        container.append(strong);
      } else if (match[5]) {
        const emphasis = document.createElement('em');
        appendInline(emphasis, token.slice(1, -1));
        container.append(emphasis);
      } else if (match[6]) {
        const deleted = document.createElement('del');
        appendInline(deleted, token.slice(2, -2));
        container.append(deleted);
      } else if (match[7]) {
        let value = token;
        let trailing = '';
        while (/[.,;:!?]$/.test(value)) {
          trailing = value.at(-1) + trailing;
          value = value.slice(0, -1);
        }
        const link = createLink(value, value);
        if (link) {
          container.append(link);
          if (trailing) container.append(document.createTextNode(trailing));
        } else {
          container.append(document.createTextNode(token));
        }
      }
      lastIndex = match.index + token.length;
    }
    if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)));
  }

  function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function renderSessionMarkdown(value) {
    const root = document.createDocumentFragment();
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list = null;
    let listType = null;
    let quote = [];
    let codeBlock = null;

    function flushParagraph() {
      if (paragraph.length === 0) return;
      const p = document.createElement('p');
      appendInline(p, paragraph.join(' ').trim());
      root.append(p);
      paragraph = [];
    }

    function flushList() {
      if (list) root.append(list);
      list = null;
      listType = null;
    }

    function flushQuote() {
      if (quote.length === 0) return;
      const blockquote = document.createElement('blockquote');
      for (const line of quote) {
        const p = document.createElement('p');
        appendInline(p, line);
        blockquote.append(p);
      }
      root.append(blockquote);
      quote = [];
    }

    function flushBlocks() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (codeBlock) {
        if (/^\s*```/.test(line)) {
          root.append(codeBlock);
          codeBlock = null;
        } else {
          codeBlock.lastChild.textContent += `${line}\n`;
        }
        continue;
      }
      if (/^\s*```/.test(line)) {
        flushBlocks();
        codeBlock = document.createElement('pre');
        codeBlock.append(document.createElement('code'));
        continue;
      }
      if (index + 1 < lines.length && line.includes('|') && isTableSeparator(lines[index + 1])) {
        flushBlocks();
        const wrapper = document.createElement('div');
        wrapper.className = 'markdown-table';
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (const cell of tableCells(line)) {
          const th = document.createElement('th');
          appendInline(th, cell);
          headerRow.append(th);
        }
        thead.append(headerRow);
        table.append(thead);
        const tbody = document.createElement('tbody');
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          const row = document.createElement('tr');
          for (const cell of tableCells(lines[index])) {
            const td = document.createElement('td');
            appendInline(td, cell);
            row.append(td);
          }
          tbody.append(row);
          index++;
        }
        index--;
        table.append(tbody);
        wrapper.append(table);
        root.append(wrapper);
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if (heading) {
        flushBlocks();
        const element = document.createElement(heading[1].length <= 2 ? 'h3' : 'h4');
        element.className = 'markdown-heading';
        appendInline(element, heading[2]);
        root.append(element);
        continue;
      }
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushBlocks();
        root.append(document.createElement('hr'));
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        flushQuote();
        const type = ordered ? 'ol' : 'ul';
        if (listType !== type) {
          flushList();
          list = document.createElement(type);
          listType = type;
        }
        const item = document.createElement('li');
        appendInline(item, (unordered || ordered)[1]);
        list.append(item);
        continue;
      }

      const quoted = line.match(/^\s*>\s?(.*)$/);
      if (quoted) {
        flushParagraph();
        flushList();
        quote.push(quoted[1]);
        continue;
      }
      if (!line.trim()) {
        flushBlocks();
        continue;
      }
      if (list) flushList();
      if (quote.length) flushQuote();
      paragraph.push(line.trim());
    }

    flushBlocks();
    if (codeBlock) root.append(codeBlock);
    return root;
  }

  window.renderSessionMarkdown = renderSessionMarkdown;
})();
