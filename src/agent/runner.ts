// Drives reply runs, one loop per chat in this process. Each loop claims the chat's oldest pending
// run through the DB lease (so two instances alive during a deploy never work one chat at once),
// keeps the lease alive while `process` works (and the typing indicator on once `process` starts it),
// then claims the next.
// A run released for a retry is held back in the DB for attempts*30 s and re-enqueued then.
// Loops that die are not restarted here: the sweeper finds their runs once the lease expires.
import { claimNextRun, deferRetry, releaseUnstarted, renewLease, type RunRow } from "../db/repo/runs";
import type { Db } from "../db/types";
import type { TgApi } from "../telegram/types";
import { errorText } from "../util/errors";
import { log } from "../util/log";

export type RunnerDeps = {
  db: Db;
  tg: Pick<TgApi, "sendChatAction">;
  /** This instance's lease owner id. */
  owner: string;
  leaseMs: number;
  renewMs: number;
  typingMs: number;
  now(): Date;
  /**
   * Works one leased run; ends it as finished, released for a retry, or with the lease lost.
   * `startTyping` turns the typing indicator on for the rest of the run (see LoopDeps.startTyping).
   */
  process(run: RunRow, work: { startTyping(): void }): Promise<void>;
  setTimeout?: typeof setTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export type Runner = {
  /** Start the chat's loop (after `delayMs`) unless stopping or one is already running here. */
  enqueue(chatId: number, delayMs?: number): void;
  /** Shutdown: no new loops, and running loops end after their current run. */
  stopAccepting(): void;
  /** Resolves when every running loop has ended. */
  drain(): Promise<void>;
  activeChats(): number[];
};

const RETRY_STEP_MS = 30_000;

type Loop = {
  /** An enqueue arrived while the loop was working: claim again before ending. */
  again: boolean;
  done: Promise<void>;
};

export function createRunner(deps: RunnerDeps): Runner {
  const { db, owner } = deps;
  const setTimer = (fn: () => void, ms: number) => (deps.setTimeout ?? setTimeout)(fn, ms);
  const every = (fn: () => void, ms: number) => (deps.setInterval ?? setInterval)(fn, ms);
  const stopEvery = (h: ReturnType<typeof setInterval>) => (deps.clearInterval ?? clearInterval)(h);
  const loops = new Map<number, Loop>();
  let stopped = false;

  function enqueue(chatId: number, delayMs = 0): void {
    if (delayMs > 0) {
      setTimer(() => enqueue(chatId), delayMs);
      return;
    }
    if (stopped) {
      // The run stays pending in the DB; the next instance's sweep picks it up.
      log("runner.enqueue_ignored", { chat_id: chatId, reason: "stopping" });
      return;
    }
    const running = loops.get(chatId);
    if (running) {
      running.again = true;
      return;
    }
    const state: Loop = { again: false, done: Promise.resolve() };
    loops.set(chatId, state);
    state.done = loop(chatId, state);
  }

  async function loop(chatId: number, state: Loop): Promise<void> {
    try {
      while (!stopped) {
        state.again = false;
        const run = await claimNextRun(db, chatId, owner, deps.leaseMs, deps.now());
        if (!run) {
          if (state.again) continue;
          break;
        }
        if (stopped) {
          // Shutdown began while the claim was in flight: give the run back untouched; the next
          // instance's sweep picks it up.
          await releaseUnstarted(db, run.id, owner);
          log("runner.released_on_stop", { chat_id: chatId, run_id: run.id });
          break;
        }
        log("runner.claimed", {
          chat_id: chatId,
          run_id: run.id,
          trigger: run.trigger.type,
          attempts: run.attempts,
          resumed: run.snapshot !== null,
        });
        const work = keepAlive(run);
        try {
          await deps.process(run, { startTyping: work.startTyping });
        } finally {
          work.stop();
        }
        const retry = await deferRetry(db, run.id, deps.now(), RETRY_STEP_MS);
        if (retry) {
          log("runner.retry_scheduled", { chat_id: chatId, run_id: run.id, attempts: retry.attempts, delay_ms: retry.delayMs });
          // Fires after this loop has ended, so it starts a fresh one.
          setTimer(() => enqueue(chatId), retry.delayMs);
          break;
        }
      }
    } catch (err) {
      log("runner.loop_error", { chat_id: chatId, error: errorText(err) });
    } finally {
      loops.delete(chatId);
    }
  }

  // Lease heartbeat for one run, plus the typing indicator once the run starts it; `stop` ends both.
  function keepAlive(run: RunRow): { startTyping(): void; stop(): void } {
    const ids = { chat_id: run.chatId, run_id: run.id };
    const heartbeat = every(() => {
      renewLease(db, run.id, owner, deps.leaseMs, deps.now()).then(
        (owned) => {
          if (!owned) log("runner.lease_renew_failed", ids);
        },
        (err) => log("runner.lease_renew_error", { ...ids, error: errorText(err) }),
      );
    }, deps.renewMs);
    const thread = run.threadId != null ? { message_thread_id: run.threadId } : {};
    const typing = () => {
      deps.tg.sendChatAction(run.chatId, "typing", thread).catch((err) => {
        log("runner.typing_failed", { ...ids, error: errorText(err) });
      });
    };
    let typer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    return {
      startTyping() {
        if (typer || stopped) return;
        typing();
        typer = every(typing, deps.typingMs);
      },
      stop() {
        stopped = true;
        stopEvery(heartbeat);
        if (typer) stopEvery(typer);
      },
    };
  }

  return {
    enqueue,
    stopAccepting() {
      stopped = true;
      log("runner.stop_accepting", { active_chats: [...loops.keys()] });
    },
    async drain() {
      while (loops.size > 0) await Promise.all([...loops.values()].map((l) => l.done));
    },
    activeChats: () => [...loops.keys()],
  };
}
