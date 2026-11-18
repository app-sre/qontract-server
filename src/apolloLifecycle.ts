import * as http from 'http';

interface StoppableServer {
  stop(): Promise<void>;
}

export type RegisterApollo = (
  sha: string,
  server: StoppableServer,
  cleanup: () => void,
) => void;

interface OwnedServer {
  server: StoppableServer;
  cleanup: () => void;
  activeRequests: number;
  retiring: boolean;
  whenIdle?: () => void;
  retirement?: Promise<void>;
}

// Owns Apollo instances independently of Express routing and bundle metadata.
export class ApolloLifecycle {
  private readonly servers = new Map<string, OwnedServer>();
  private closing = false;
  private loading = 0;
  private whenLoadsIdle?: () => void;
  private shutdown?: Promise<void>;

  add(sha: string, server: StoppableServer, cleanup: () => void): void {
    if (this.closing) throw new Error('Apollo lifecycle is shutting down');
    this.register(sha, server, cleanup);
  }

  private register(
    sha: string,
    server: StoppableServer,
    cleanup: () => void,
  ): void {
    if (this.servers.has(sha))
      throw new Error(`Cannot register Apollo server for bundle ${sha}`);
    this.servers.set(sha, {
      server,
      cleanup,
      activeRequests: 0,
      retiring: false,
    });
  }

  acquire(sha: string): (() => void) | undefined {
    const entry = this.servers.get(sha);
    if (this.closing || !entry || entry.retiring) return undefined;
    entry.activeRequests++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.activeRequests--;
      if (entry.activeRequests === 0) entry.whenIdle?.();
    };
  }

  retire(sha: string): Promise<void> {
    const entry = this.servers.get(sha);
    if (!entry) return Promise.resolve();
    if (entry.retirement) return entry.retirement;
    entry.retiring = true;
    entry.retirement = (async () => {
      if (entry.activeRequests > 0) {
        await new Promise<void>((resolve) => {
          entry.whenIdle = resolve;
        });
      }
      await entry.server.stop();
      entry.cleanup();
      this.servers.delete(sha);
    })().catch((error) => {
      // Keep ownership and reject new queries; the next expiration can retry stop.
      entry.retirement = undefined;
      throw error;
    });
    return entry.retirement;
  }

  async trackLoad(
    work: (register: RegisterApollo) => Promise<void>,
  ): Promise<void> {
    if (this.closing) throw new Error('Apollo lifecycle is shutting down');
    this.loading++;
    let active = true;
    try {
      await work((sha, server, cleanup) => {
        if (!active) throw new Error('Bundle load already completed');
        // Already-admitted loads may register while shutdown waits for them.
        this.register(sha, server, cleanup);
      });
    } finally {
      active = false;
      this.loading--;
      if (this.loading === 0) this.whenLoadsIdle?.();
    }
  }

  stopAll(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = (async () => {
      // Aborted HTTP requests can leave asynchronous bundle loading in progress.
      if (this.loading > 0) {
        await new Promise<void>((resolve) => {
          this.whenLoadsIdle = resolve;
        });
      }
      const results = await Promise.allSettled(
        [...this.servers.keys()].map((sha) => this.retire(sha)),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return this.shutdown;
  }
}

// Close HTTP first so reloads/context creation cannot register work after stopAll.
export const shutdownHttpServer = async (
  server: http.Server,
  lifecycle: ApolloLifecycle,
  timeoutMs = 15_000,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error('Timed out draining HTTP and Apollo servers'));
    }, timeoutMs);
  });
  const drain = (async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: NodeJS.ErrnoException) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    await lifecycle.stopAll();
  })();
  try {
    await Promise.race([drain, deadline]);
  } finally {
    clearTimeout(timer);
  }
};
