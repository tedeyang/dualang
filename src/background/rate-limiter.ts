const RATE_LIMIT_KEY = 'dualang_rate_limit_v1';
const MAX_CONCURRENCY = 100;
const MAX_RPM = 500;
const MAX_TPM = 3_000_000;

export type RegisterTaskFn = (priority: number, abortFn: () => void) => () => void;

interface QueueItem {
  tokenEstimate: number;
  priority: number;
  resolve: (value: RegisterTaskFn) => void;
  reject: (reason: any) => void;
}

interface RunningTask {
  priority: number;
  abort: () => void;
}

interface RateLimitState {
  requests: number[];                       // 最近 60 秒内的请求时间戳
  tokensPerMin: Array<{ ts: number; count: number }>;
}

export class RateLimiter {
  running: number;
  queue: QueueItem[];
  runningTasks: RunningTask[];
  private _ioChain: Promise<any>;
  private _preemptionPending: boolean;

  constructor() {
    this.running = 0;
    this.queue = [];
    this.runningTasks = [];
    this._ioChain = Promise.resolve();
    this._preemptionPending = false;
  }

  // 串行化所有 chrome.storage.local 的 read-modify-write。若多个 acquire 并发读取
  // 同一限额状态后各自写入，彼此会覆盖对方的计数，导致 RPM/TPM 记录丢失、实际请求
  // 数超过配额上限。通过 promise 链保证任意时刻只有一个 check+persist 序列在执行。
  private _withIoLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._ioChain.then(fn, fn);
    this._ioChain = run.catch(() => {}); // 单次失败不阻塞后续链
    return run;
  }

  async acquire(tokenEstimate: number, priority = 0): Promise<RegisterTaskFn> {
    return new Promise<RegisterTaskFn>((resolve, reject) => {
      this.queue.push({ tokenEstimate, priority, resolve, reject });
      this.queue.sort((a, b) => b.priority - a.priority);
      this._process();
    });
  }

  _process() {
    if (this.queue.length === 0) return;

    if (this.running >= MAX_CONCURRENCY) {
      // 已有抢占在途时不再 abort 其它 victim，避免同一个队首任务触发多次抢占
      if (this._preemptionPending) return;
      const next = this.queue[0];
      const victim = this._findLowestPriorityRunning();
      if (victim && next.priority > victim.priority) {
        this._preemptionPending = true;
        victim.abort();
        // victim 的 release 回调会重置 _preemptionPending 并触发 _process
      }
      return;
    }

    const next = this.queue.shift()!;

    // priority >= 2 是用户即时操作（Show more / 手动按钮 / 重试）。
    // 绕过 _checkAndPersist 冷却、也不等 IO 锁 — 宁可让服务端返 429，也不让用户
    // 眼前的内容被低优先级的 RPM/TPM 本地等待 sleep 卡住。
    // 持久化仍 fire-and-forget（计数最终还是会被记录，可能与锁内 RMW 有极少量
    // 丢失，但 priority 2 请求本就稀疏，可接受）。
    const bypassLimits = next.priority >= 2;
    const work = bypassLimits
      ? (() => { this._persistAdd(next.tokenEstimate).catch(() => {}); return Promise.resolve(); })()
      : this._withIoLock(() => this._checkAndPersist(next.tokenEstimate));

    work
      .then(() => {
        next.resolve((priority: number, abortFn: () => void) => {
          this.running++;
          const task = { priority, abort: abortFn };
          this.runningTasks.push(task);
          return () => this._release(task);
        });
      })
      .catch(err => {
        // registerTask 永远不会被调用 —— 如果 abort 是作为 victim 触发的，
        // 释放流程（_release）不会跑，必须在此兜底清除抢占锁，避免死锁。
        this._preemptionPending = false;
        next.reject(err);
      });
  }

  private _release(task: RunningTask) {
    this.running--;
    const idx = this.runningTasks.indexOf(task);
    if (idx !== -1) this.runningTasks.splice(idx, 1);
    this._preemptionPending = false;
    this._process();
  }

  _findLowestPriorityRunning() {
    if (this.runningTasks.length === 0) return null;
    return this.runningTasks.reduce((min, t) => t.priority < min.priority ? t : min);
  }

  /**
   * 合并后的 RMW：单次 storage.get 读配额状态 → check → push → 单次 storage.set。
   * 原实现拆成 _checkLimits + _persistAdd 两次 round-trip，多一次 IO。
   * 若触发 RPM/TPM 上限则 sleep + 递归重入；递归时不再续借 ioLock（_withIoLock 已
   * 把本次整个流程序列化，内部 sleep 期间其他 acquire 会在 ioChain 上等）。
   */
  async _checkAndPersist(tokenEstimate: number): Promise<void> {
    const rl = await this._loadPruned();
    const now = Date.now();

    if (rl.requests.length >= MAX_RPM) {
      const wait = rl.requests[rl.requests.length - MAX_RPM] + 60_000 - now;
      if (wait > 0) {
        await this._sleep(wait);
        return this._checkAndPersist(tokenEstimate);
      }
    }

    const tpmSum = rl.tokensPerMin.reduce((s, r) => s + r.count, 0);
    if (tpmSum + tokenEstimate > MAX_TPM) {
      const earliest = rl.tokensPerMin[0]?.ts || now;
      const wait = earliest + 60_000 - now;
      if (wait > 0) {
        await this._sleep(wait);
        return this._checkAndPersist(tokenEstimate);
      }
    }

    rl.requests.push(now);
    rl.tokensPerMin.push({ ts: now, count: tokenEstimate });
    await chrome.storage.local.set({ [RATE_LIMIT_KEY]: rl });
  }

  /**
   * priority>=2 用户即时操作的轻量追加路径：不做限额检查，仅记账。
   * fire-and-forget；小量竞态丢失可接受（这类请求本就稀疏）。
   */
  async _persistAdd(tokenEstimate: number): Promise<void> {
    const rl = await this._loadPruned();
    const now = Date.now();
    rl.requests.push(now);
    rl.tokensPerMin.push({ ts: now, count: tokenEstimate });
    await chrome.storage.local.set({ [RATE_LIMIT_KEY]: rl });
  }

  private async _loadPruned(): Promise<RateLimitState> {
    const data = await chrome.storage.local.get(RATE_LIMIT_KEY);
    const raw = data[RATE_LIMIT_KEY] || {};
    const now = Date.now();
    return {
      requests: (raw.requests || []).filter((ts: number) => now - ts < 60_000),
      tokensPerMin: (raw.tokensPerMin || []).filter((r: { ts: number }) => now - r.ts < 60_000),
    };
  }

  _sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const rateLimiter = new RateLimiter();
