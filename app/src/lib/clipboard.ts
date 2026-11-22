/** Copies text; falls back to execCommand outside a secure context (access via a LAN IP). */
export async function copyText(text: string): Promise<void> {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- the DOM types `navigator.clipboard` as always there; a page outside a secure context does not have it
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy refused by the browser');
}
