/**
 * Content script 的埋点聚合器。集中管理：
 *   - 计数器（increment / add）
 *   - RTT / 渲染耗时等 running-average 场景
 *   - 定时 summary 打印（只在有新活动时打印，避免 idle 时刷屏）
 *   - perfLog / logBiz 两种语义的输出 —— 实际写 console 走 shared logger
 *
 * 替代散落在 content/index.ts 顶层的 perfCounters 对象 + 十几处 increment
 * + 10s setInterval 匿名函数。所有 call site 走 `telemetry.inc('enqueue')`
 * 这种单入口，新增指标只加一行。
 */

import { log } from '../shared/logger';

export type Level = 'log' | 'warn' | 'error';

export class Telemetry {
  private counters: Record<string, number> = {};
  /** 外部订阅的活动快照，summary 用于判断是否有新活动打印 */
  private activitySnapshot = 0;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  /** summary 额外注入的字段（queue 长度等实时状态，不宜放 counter）*/
  private liveFields: () => Record<string, number | string> = () => ({});

  inc(name: string, by = 1): void {
    this.counters[name] = (this.counters[name] || 0) + by;
  }

  add(name: string, by: number): void {
    this.counters[name] = (this.counters[name] || 0) + by;
  }

  get(name: string): number {
    return this.counters[name] || 0;
  }

  /** 详细性能埋点：debug 级，DevTools verbose 才可见 */
  perf(event: string, data: any = {}): void {
    log.debug(`perf.${event}`, data);
  }

  /** 业务语义日志：默认 info；warn 用于非致命异常；error 用于用户可见失败 */
  biz(event: string, data: any = {}, level: Level = 'log'): void {
    if (level === 'warn') log.warn(event, data);
    else if (level === 'error') log.error(event, data);
    else log.info(event, data);
  }

  /**
   * 启动周期性 summary。`liveFields` 提供实时队列长度等快照字段；
   * `activityKey` 用于判断是否有新活动（不变则不打印）。
   */
  startSummary(
    intervalMs: number,
    liveFields: () => Record<string, number | string>,
    activityKey: () => number,
  ): void {
    if (this.summaryTimer) return;
    this.liveFields = liveFields;
    this.summaryTimer = setInterval(() => {
      const activity = activityKey();
      if (activity === this.activitySnapshot) {
        const live = liveFields();
        const hasLive = Object.values(live).some((v) => typeof v === 'number' ? v > 0 : !!v);
        if (!hasLive) return;
      }
      this.activitySnapshot = activity;
      const apiCalls = this.get('apiCalls');
      const apiTotalRtt = this.get('apiTotalRtt');
      const renderCalls = this.get('renderCalls');
      const renderTotalTime = this.get('renderTotalTime');
      this.perf('summary', {
        ...this.counters,
        avgApiRttMs: apiCalls > 0 ? parseFloat((apiTotalRtt / apiCalls).toFixed(1)) : 0,
        avgRenderMs: renderCalls > 0 ? parseFloat((renderTotalTime / renderCalls).toFixed(2)) : 0,
        ...liveFields(),
      });
    }, intervalMs);
  }

  stopSummary(): void {
    if (this.summaryTimer) {
      clearInterval(this.summaryTimer);
      this.summaryTimer = null;
    }
  }
}

export const telemetry = new Telemetry();
