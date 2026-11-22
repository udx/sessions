#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

class Node {
  constructor(type, value = '') {
    this.type = type;
    this.value = value;
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }

  get lastChild() {
    return this.children.at(-1) || null;
  }

  get textContent() {
    return this.type === 'text' ? this.value : this.children.map(node => node.textContent).join('');
  }

  set textContent(value) {
    this.children = [new Node('text', String(value))];
  }
}

const document = {
  createElement: type => new Node(type),
  createTextNode: value => new Node('text', value),
  createDocumentFragment: () => new Node('fragment')
};
const sandbox = { document, URL, window: {} };
vm.runInNewContext(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'markdown.js'), 'utf8'),
  sandbox
);
const render = sandbox.window.renderSessionMarkdown;
assert.equal(typeof render, 'function');

function elements(root, type) {
  const found = [];
  function visit(node) {
    if (node.type === type) found.push(node);
    for (const child of node.children) visit(child);
  }
  visit(root);
  return found;
}

const result = render(`## Release **complete**

- **Source:** \`abc123\`
- [PR #848](https://github.com/udx/wp-stateless/pull/848)

| Check | Result |
| --- | --- |
| Tests | **Passed** |

\`\`\`html
<script>window.compromised = true</script>
\`\`\`

<script>window.compromised = true</script>
[Unsafe](javascript:alert(1))
`);

assert.equal(elements(result, 'h3').length, 1);
assert.equal(elements(result, 'li').length, 2);
assert.equal(elements(result, 'tr').length, 2);
assert.equal(elements(result, 'pre').length, 1);
assert(elements(result, 'strong').length >= 3);
assert.equal(elements(result, 'script').length, 0);
assert.equal(elements(result, 'img').length, 0);
assert(result.textContent.includes('<script>window.compromised = true</script>'));
const links = elements(result, 'a');
assert.equal(links.length, 1);
assert.equal(links[0].href, 'https://github.com/udx/wp-stateless/pull/848');
assert.equal(links[0].target, '_blank');
assert.equal(links[0].rel, 'noopener noreferrer nofollow');
assert(result.textContent.includes('[Unsafe](javascript:alert(1))'));
console.log('  ✓ Markdown renders common blocks and inline formatting');
console.log('  ✓ raw HTML and unsafe links cannot execute');

const bareUrls = render('Open http://localhost:4220/ and **https://example.com/docs**. Next.');
const bareUrlLinks = elements(bareUrls, 'a');
assert.equal(bareUrlLinks.length, 2);
assert.equal(bareUrlLinks[0].href, 'http://localhost:4220/');
assert.equal(bareUrlLinks[0].textContent, 'http://localhost:4220/');
assert.equal(bareUrlLinks[1].href, 'https://example.com/docs');
assert.equal(bareUrlLinks[1].textContent, 'https://example.com/docs');
assert.equal(elements(bareUrls, 'strong').length, 1);
console.log('  ✓ bare URLs render as links without recursion or Markdown delimiters\n');
console.log('3 passed, 0 failed\n');
