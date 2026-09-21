/**
 * One interactive prompt, because installing into every agent on a machine is
 * rarely what "install this for me" means.
 *
 * Deliberately dependency-free: node:readline is enough for a numbered menu, and
 * the project pulls in nothing at runtime.
 *
 * The reading is done with a line queue rather than `readline.question`, because
 * question() attaches a one-shot 'line' listener: when input arrives as one chunk
 * (a pipe, a test, a script) the extra lines are emitted before the listener
 * exists and are silently lost, and at EOF the promise never settles at all.
 */

import readline from "node:readline";

export interface SelectableTarget {
  harness: string;
  label: string;
  binary: string;
  version: string;
}

/**
 * A yes/no question, defaulting to no.
 *
 * Used where the safe answer is also the recommended one, so pressing Enter never
 * changes anything on the machine.
 */
export async function askYesNo(question: string, detail?: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const queued: string[] = [];
  let waiting: ((line: string) => void) | null = null;
  let ended = false;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve("");
    }
  });
  const ask = (text: string): Promise<string> => {
    process.stdout.write(text);
    const ready = queued.shift();
    if (ready !== undefined) {
      process.stdout.write(`${ready}\n`);
      return Promise.resolve(ready.trim());
    }
    if (ended) return Promise.resolve("");
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  try {
    if (detail) process.stdout.write(`${detail}\n`);
    for (;;) {
      const answer = (await ask(`${question} [y/N] `)).toLowerCase();
      if (answer === "") return false;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      process.stdout.write('Answer "y" or "n".\n');
    }
  } finally {
    rl.close();
  }
}

/**
 * Show the detected agents and return the ones the user picked.
 *
 * Accepts "1", "1,3", "1 3", "a" for all, "n" for none, and re-asks on anything
 * else instead of guessing. Returns [] when the user declines or the input ends,
 * which callers treat as "do nothing" rather than as an error.
 */
export async function askSelection(targets: SelectableTarget[]): Promise<string[]> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const queued: string[] = [];
  let waiting: ((line: string) => void) | null = null;
  let ended = false;

  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    ended = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve("");
    }
  });

  const ask = (question: string): Promise<string> => {
    process.stdout.write(question);
    const ready = queued.shift();
    if (ready !== undefined) {
      process.stdout.write(`${ready}\n`);
      return Promise.resolve(ready.trim());
    }
    if (ended) return Promise.resolve("");
    return new Promise((resolve) => {
      waiting = resolve;
    });
  };

  try {
    process.stdout.write(
      [
        "",
        "session-hub can be installed into these agents, all found on your PATH:",
        "",
        ...targets.map(
          (target, index) => `  ${index + 1}) ${target.label.padEnd(12)} ${target.version || target.binary}`,
        ),
        "",
        'Type one or more numbers separated by commas, "a" for all, or "n" for none.',
        "",
      ].join("\n") + "\n",
    );

    for (;;) {
      const answer = (await ask("Install into: ")).toLowerCase();

      // Empty means end of input, which is a cancel, not a silent default.
      if (answer === "" || answer === "n" || answer === "none" || answer === "q") return [];
      if (answer === "a" || answer === "all") return targets.map((t) => t.harness);

      const picked: number[] = [];
      let invalid = "";
      for (const piece of answer.split(/[\s,]+/).filter(Boolean)) {
        const n = Number(piece);
        if (!Number.isInteger(n) || n < 1 || n > targets.length) {
          invalid = piece;
          break;
        }
        if (!picked.includes(n)) picked.push(n);
      }
      if (!invalid && picked.length > 0) return picked.map((n) => targets[n - 1].harness);

      process.stdout.write(
        `${invalid ? `"${invalid}" is not one of the numbers above. ` : ""}Try again, for example 1 or 1,3 (or "n" to cancel).\n`,
      );
    }
  } finally {
    rl.close();
  }
}
