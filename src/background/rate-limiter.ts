const RATE_LIMIT_KEY = 'dualang_rate_limit_v1';
const MAX_CONCURRENCY = 100;
const MAX_RPM = 500;
const MAX_TPM = 3000000;
const MAX_TPD = Infinity;

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
    // 绕过 _checkLimits 冷却、也不等 IO 锁 — 宁可让服务端返 429，也不让用户
    // 眼前的内容被低优先级的 RPM/TPM 本地等待 sleep 卡住。
    // 持久化仍 fire-and-forget（计数最终还是会被记录，可能与锁内 RMW 有极少量
    // 丢失，但 priority 2 请求本就稀疏，可接受）。
    const bypassLimits = next.priority >= 2;
    const work = bypassLimits
      ? (() => { this._persistAdd(next.tokenEstimate).catch(() => {}); return Promise.resolve(); })()
      : this._withIoLock(async () => {
          await this._checkLimits(next.tokenEstimate);
          await this._persistAdd(next.tokenEstimate);
        });

    work
      .then(() => {
        next.resolve((priority: number, abortFn: () => void) => {
          this.running++;
          const task = { priority, abort: abortFn };
          this.runningTasks.push(task);
          return () => {
            this.running--;
            const idx = this.runningTasks.indexOf(task);
            if (idx !== -1) this.runningTasks.splice(idx, 1);
            this._preemptionPending = false;
            this._process();
          };
        });
      })
      .catch(err => next.reject(err));
  }

  _findLowestPriorityRunning() {
    if (this.runningTasks.length === 0) return null;
    return this.runningTasks.reduce((min, t) => t.priority < min.priority ? t : min);
  }

  async _checkLimits(tokenEstimate: number) {
    const data = await chrome.storage.local.get(RATE_LIMIT_KEY);
    const rl = data[RATE_LIMIT_KEY] || { requests: [], tokensPerMin: [], tokensPerDay: [] };
    const now = Date.now();

    const requests = (rl.requests || []).filter(ts => now - ts < 60000);
    const tokensPerMin = (rl.tokensPerMin || []).filter(r => now - r.ts < 60000);
    const tokensPerDay = (rl.tokensPerDay || []).filter(r => now - r.ts < 24 * 60 * 60 * 1000);

    if (requests.length >= MAX_RPM) {
      const wait = requests[requests.length - MAX_RPM] + 60000 - now;
      if (wait > 0) {
        await this._sleep(wait);
        return this._checkLimits(tokenEstimate);
      }
    }

    const tpmSum = tokensPerMin.reduce((s, r) => s + r.count, 0);
    if (tpmSum + tokenEstimate > MAX_TPM) {
      const earliest = tokensPerMin[0]?.ts || now;
      const wait = earliest + 60000 - now;
      if (wait > 0) {
        await this._sleep(wait);
        return this._checkLimits(tokenEstimate);
      }
    }

    const tpdSum = tokensPerDay.reduce((s, r) => s + r.count, 0);
    if (tpdSum + tokenEstimate > MAX_TPD) {
      throw new Error('超出每日 Token 限额，请明天再试');
    }
  }

  async _persistAdd(tokenEstimate: number) {
    const data = await chrome.storage.local.get(RATE_LIMIT_KEY);
    const rl = data[RATE_LIMIT_KEY] || { requests: [], tokensPerMin: [], tokensPerDay: [] };
    const now = Date.now();

    rl.requests = (rl.requests || []).filter(ts => now - ts < 60000);
    rl.tokensPerMin = (rl.tokensPerMin || []).filter(r => now - r.ts < 60000);
    rl.tokensPerDay = (rl.tokensPerDay || []).filter(r => now - r.ts < 24 * 60 * 60 * 1000);

    rl.requests.push(now);
    rl.tokensPerMin.push({ ts: now, count: tokenEstimate });
    rl.tokensPerDay.push({ ts: now, count: tokenEstimate });

    await chrome.storage.local.set({ [RATE_LIMIT_KEY]: rl });
  }

  _sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export const rateLimiter = new RateLimiter();
