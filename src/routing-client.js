// Keep just one calculation in flight and one latest request. Old results never replace a new view.
export class RoutingClient {
  constructor(init, fallback, onResult) {
    this.fallback = fallback;
    this.onResult = onResult;
    this.version = 0;
    this.pending = null;
    this.active = null;
    try {
      this.worker = new Worker(new URL('./routing-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        if (data.error) { this.useFallback(); return; }
        clearTimeout(this.timeout);
        this.active = null;
        if (data.id === this.version) this.onResult(data.output);
        this.flush();
      };
      this.worker.onerror = (event) => { event.preventDefault(); this.useFallback(); };
      this.worker.onmessageerror = () => this.useFallback();
      this.worker.postMessage({ type: 'init', ...init });
    } catch { this.useFallback(); }
  }

  request(origin, enabled) {
    this.pending = { id: ++this.version, origin: { ...origin }, enabled: { ...enabled } };
    this.flush();
  }

  flush() {
    if (this.active || !this.pending) return;
    const job = this.active = this.pending;
    this.pending = null;
    if (this.worker) {
      this.timeout = setTimeout(() => this.useFallback(), 15000);
      try { this.worker.postMessage(job); } catch { this.useFallback(); }
    } else {
      // Yield before the synchronous fallback so the selected control can paint first.
      setTimeout(() => {
        this.active = null;
        if (job.id === this.version) this.onResult(this.fallback(job.origin, job.enabled));
        this.flush();
      }, 0);
    }
  }

  useFallback() {
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = null;
    this.pending ||= this.active;
    this.active = null;
    this.flush();
  }
}
