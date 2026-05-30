/**
 * Overlay popup (M3) — ONE reused DOM element for the active marker tooltip
 * (decision D10: rich content without thousands of nodes). The viewer shows it on
 * hover when a `markerTooltip` callback returns content, and hides it otherwise.
 *
 * Positioned `fixed` at the pointer's client coordinates (offset slightly) so it
 * needs no particular positioning on the host's layout. A string is set via
 * `textContent` (XSS-safe by default); an `HTMLElement` lets a host supply rich,
 * pre-built content it is responsible for.
 */
export class OverlayPopup {
  private readonly el: HTMLDivElement;
  private attached = false;

  constructor(private readonly doc: Document = document) {
    this.el = doc.createElement('div');
    const s = this.el.style;
    s.position = 'fixed';
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    s.maxWidth = '320px';
    s.padding = '6px 9px';
    s.borderRadius = '5px';
    s.background = 'rgba(16, 19, 25, 0.94)';
    s.color = '#d6dbe3';
    s.border = '1px solid #2c3340';
    s.font = '12px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    s.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.4)';
    s.whiteSpace = 'pre-line';
    s.display = 'none';
  }

  /** Show `content` near client point `(clientX, clientY)`. */
  show(content: string | HTMLElement, clientX: number, clientY: number): void {
    if (typeof content === 'string') {
      this.el.textContent = content;
    } else {
      this.el.replaceChildren(content);
    }
    this.el.style.left = `${clientX + 12}px`;
    this.el.style.top = `${clientY + 12}px`;
    this.el.style.display = 'block';
    if (!this.attached) {
      this.doc.body.appendChild(this.el);
      this.attached = true;
    }
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  /** Remove the element from the DOM. Call on viewer teardown. */
  destroy(): void {
    if (this.attached) {
      this.el.remove();
      this.attached = false;
    }
  }
}
