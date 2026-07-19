// DOM-based HTML sanitizer: tag allowlist, all attributes stripped.
const ALLOWED = new Set(['B', 'I', 'U', 'STRONG', 'EM', 'P', 'BR', 'DIV', 'H1', 'H2', 'H3', 'UL', 'OL', 'LI', 'SPAN']);

export function sanitizeHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  (function walk(node: Node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (!ALLOWED.has(el.tagName)) {
          while (el.firstChild) node.insertBefore(el.firstChild, el);
          node.removeChild(el);
          continue;
        }
        for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
        walk(el);
      } else if (child.nodeType !== Node.TEXT_NODE) {
        node.removeChild(child);
      }
    }
  })(tpl.content);
  const div = document.createElement('div');
  div.appendChild(tpl.content.cloneNode(true));
  return div.innerHTML;
}
