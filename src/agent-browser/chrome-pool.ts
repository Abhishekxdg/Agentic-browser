/**
 * Chrome Pool — manages concurrent browser sessions with limits.
 * Max N Chrome processes. Queue overflow. Auto-restart dead sessions.
 */

import { createSession, closeSession, type BrowserSession } from "./session-manager.ts";
import type { SessionConfig } from "./session-manager.ts";

export interface PoolConfig {
  max_sessions?: number;      // max concurrent Chrome processes (default: 5)
  idle_timeout_ms?: number;   // close idle sessions after this (default: 30min)
  max_queue?: number;         // max queued requests before rejecting (default: 20)
}

interface PoolEntry {
  session: BrowserSession;
  in_use: boolean;
  created_at: number;
  last_used: number;
  use_count: number;
}

interface QueueEntry {
  config: SessionConfig;
  resolve: (session: BrowserSession) => void;
  reject: (err: Error) => void;
  queued_at: number;
}

export class ChromePool {
  private entries = new Map<string, PoolEntry>();
  private queue: QueueEntry[] = [];
  private config: Required<PoolConfig>;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: PoolConfig = {}) {
    this.config = {
      max_sessions: Number(process.env.MAX_SESSIONS || config.max_sessions || 5),
      idle_timeout_ms: config.idle_timeout_ms ?? 30 * 60 * 1000,
      max_queue: config.max_queue ?? 20,
    };

    // Periodic cleanup of idle sessions
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /** Acquire a session from the pool. Creates one if space available, otherwise queues. */
  async acquire(sessionConfig: SessionConfig = {}): Promise<BrowserSession> {
    // Check for idle session we can reuse
    for (const [, entry] of this.entries) {
      if (!entry.in_use && entry.session.cdp.isConnected) {
        entry.in_use = true;
        entry.last_used = Date.now();
        entry.use_count++;
        return entry.session;
      }
    }

    // Create new session if under limit
    if (this.entries.size < this.config.max_sessions) {
      return this.createAndAdd(sessionConfig);
    }

    // Queue if not at max queue
    if (this.queue.length >= this.config.max_queue) {
      throw new Error(`Chrome pool exhausted: ${this.entries.size} sessions, ${this.queue.length} queued. Try again later.`);
    }

    return new Promise<BrowserSession>((resolve, reject) => {
      this.queue.push({ config: sessionConfig, resolve, reject, queued_at: Date.now() });
    });
  }

  /** Release a session back to the pool. */
  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;

    entry.in_use = false;
    entry.last_used = Date.now();

    // Drain queue
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      entry.in_use = true;
      entry.use_count++;
      next.resolve(entry.session);
    }
  }

  /** Close and remove a session from the pool. */
  async evict(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    await closeSession(sessionId).catch(() => {});

    // Drain queue by creating a new session
    if (this.queue.length > 0 && this.entries.size < this.config.max_sessions) {
      const next = this.queue.shift()!;
      this.createAndAdd(next.config).then(next.resolve).catch(next.reject);
    }
  }

  stats() {
    const entries = Array.from(this.entries.values());
    return {
      total: entries.length,
      active: entries.filter((e) => e.in_use).length,
      idle: entries.filter((e) => !e.in_use).length,
      queued: this.queue.length,
      max: this.config.max_sessions,
      sessions: entries.map((e) => ({
        id: e.session.id,
        in_use: e.in_use,
        use_count: e.use_count,
        idle_ms: e.in_use ? 0 : Date.now() - e.last_used,
        connected: e.session.cdp.isConnected,
      })),
    };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    // Reject all queued
    for (const q of this.queue) q.reject(new Error("Pool shutting down"));
    this.queue = [];
    // Close all sessions
    await Promise.all(Array.from(this.entries.keys()).map((id) => closeSession(id).catch(() => {})));
    this.entries.clear();
  }

  private async createAndAdd(config: SessionConfig): Promise<BrowserSession> {
    const session = await createSession(config);
    this.entries.set(session.id, {
      session, in_use: true,
      created_at: Date.now(), last_used: Date.now(), use_count: 1,
    });
    return session;
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      // Kill disconnected sessions
      if (!entry.session.cdp.isConnected) {
        console.log(`[pool] evicting dead session ${id}`);
        await this.evict(id);
        continue;
      }
      // Kill idle sessions past timeout
      if (!entry.in_use && now - entry.last_used > this.config.idle_timeout_ms) {
        console.log(`[pool] evicting idle session ${id} (${Math.round((now - entry.last_used) / 1000)}s idle)`);
        await this.evict(id);
      }
    }
  }
}

// Singleton pool used by the server
export const pool = new ChromePool();
