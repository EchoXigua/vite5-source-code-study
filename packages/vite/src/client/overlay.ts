export const overlayId = "vite-error-overlay";
export class ErrorOverlay extends HTMLElement {
  close(): void {
    this.parentNode?.removeChild(this);
    // document.removeEventListener('keydown', this.closeOnEsc)
  }
}
