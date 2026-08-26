import { RateLimitError } from "./native-api";
import type { Presence, PresenceReply } from "./types";

const MAX_REQUESTS_PER_MINUTE = 40;
const REFILL_PER_MS = MAX_REQUESTS_PER_MINUTE / 60_000;

export function cadenceForMemberCount(memberCount: number): {
  cycleMs: number;
  requestSpacingMs: number;
  staleNotice: boolean;
} {
  if (memberCount <= 0) {
    return { cycleMs: 60_000, requestSpacingMs: 60_000, staleNotice: false };
  }
  if (memberCount <= 25) {
    return {
      cycleMs: 60_000,
      requestSpacingMs: 60_000 / memberCount,
      staleNotice: false,
    };
  }
  if (memberCount <= 50) {
    return {
      cycleMs: 90_000,
      requestSpacingMs: 90_000 / memberCount,
      staleNotice: false,
    };
  }

  const cycleMs = (memberCount / MAX_REQUESTS_PER_MINUTE) * 60_000;
  return {
    cycleMs,
    requestSpacingMs: 60_000 / MAX_REQUESTS_PER_MINUTE,
    staleNotice: memberCount > 150,
  };
}

export class PresenceStateCache {
  private readonly values = new Map<string, Presence>();

  update(userId: string, presence: Presence): boolean {
    if (this.values.get(userId) === presence) return false;
    this.values.set(userId, presence);
    return true;
  }

  clear(): void {
    this.values.clear();
  }
}

interface SchedulerOptions {
  request: (userId: string) => Promise<PresenceReply>;
  onChange: (reply: PresenceReply) => void;
  onRateLimit: (retryAfterSeconds: number) => void;
  onError: (error: Error) => void;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PresenceScheduler {
  private targets: string[] = [];
  private cursor = 0;
  private generation = 0;
  private paused = false;
  private tokens = 8;
  private lastRefillAt = Date.now();
  private blockedUntil = 0;
  private readonly cache = new PresenceStateCache();

  constructor(private readonly options: SchedulerOptions) {}

  start(targets: string[]): void {
    this.stop();
    this.targets = [...new Set(targets)];
    this.cursor = 0;
    this.cache.clear();
    this.paused = false;
    this.blockedUntil = 0;
    this.tokens = 8;
    this.lastRefillAt = Date.now();
    const generation = this.generation;
    void this.run(generation);
  }

  stop(): void {
    this.generation += 1;
    this.targets = [];
    this.cursor = 0;
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.generation += 1;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const generation = this.generation;
    void this.run(generation);
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(8, this.tokens + (now - this.lastRefillAt) * REFILL_PER_MS);
    this.lastRefillAt = now;
  }

  private async takeToken(): Promise<void> {
    while (true) {
      this.refill();
      const now = Date.now();
      if (now < this.blockedUntil) {
        await delay(Math.min(this.blockedUntil - now, 1_000));
        continue;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await delay(Math.ceil((1 - this.tokens) / REFILL_PER_MS));
    }
  }

  private async run(generation: number): Promise<void> {
    while (generation === this.generation && !this.paused && this.targets.length > 0) {
      const userId = this.targets[this.cursor];
      if (!userId) return;

      await this.takeToken();
      if (generation !== this.generation || this.paused) return;

      const startedAt = Date.now();
      try {
        const reply = await this.options.request(userId);
        if (this.cache.update(reply.userId, reply.presence)) {
          this.options.onChange(reply);
        }
        this.cursor = (this.cursor + 1) % this.targets.length;
      } catch (error) {
        if (error instanceof RateLimitError) {
          this.blockedUntil = Date.now() + error.retryAfterSeconds * 1_000;
          this.options.onRateLimit(error.retryAfterSeconds);
        } else {
          this.options.onError(
            error instanceof Error ? error : new Error("Presence refresh failed"),
          );
          this.cursor = (this.cursor + 1) % this.targets.length;
        }
      }

      const spacing = cadenceForMemberCount(this.targets.length).requestSpacingMs;
      await delay(Math.max(0, spacing - (Date.now() - startedAt)));
    }
  }
}
