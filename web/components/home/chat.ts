// The hero's looping conversation between two peers, played on two screens
// (`[data-phone="a"]` and `[data-phone="b"]` in hero.astro). A line is typed
// into the sender's composer, sent, flown across the scene (`onSend` starts
// the flight), and lands on the other screen. Bubbles are cloned from the
// `<template data-bubble="out|in">` elements so their styles live in markup.
import type { Flight } from "./scene";
import { FLIGHT } from "./scene";

type Side = Flight["from"];

const SCRIPT: readonly { readonly from: Side; readonly text: string }[] = [
  { from: "a", text: "here's the plan for saturday" },
  { from: "b", text: "got it. who else can read it?" },
  { from: "a", text: "nobody. phone to phone" },
  { from: "b", text: "no server in between?" },
  { from: "a", text: "nothing in the middle." },
];

const other = (side: Side): Side => (side === "a" ? "b" : "a");

const required = <T extends Element>(root: ParentNode, selector: string) => {
  const el = root.querySelector<T>(selector);

  if (!el) {
    throw new Error(`Missing ${selector}`);
  }

  return el;
};

interface Step {
  // Milliseconds from the start of the pass.
  readonly at: number;
  readonly run: () => void;
}

// Plays the conversation inside `root`; returns a stop function. With `still`
// set it shows the whole conversation at once, delivered, with no motion.
export const conversation = (
  root: HTMLElement,
  { still, onSend }: { still: boolean; onSend: (from: Side) => void }
) => {
  const phone = (side: Side) => {
    const el = required<HTMLElement>(root, `[data-phone="${side}"]`);

    return {
      log: required<HTMLOListElement>(el, "[data-log]"),
      draft: required<HTMLElement>(el, "[data-draft]"),
    };
  };

  const phones = { a: phone("a"), b: phone("b") };
  const screens = Object.values(phones);
  const delivered = required<HTMLElement>(root, "[data-delivered]");
  let count = 0;

  const bubble = (kind: "out" | "in", text: string) => {
    const template = required<HTMLTemplateElement>(
      root,
      `template[data-bubble="${kind}"]`
    );

    const li = template.content.firstElementChild?.cloneNode(true);

    if (!(li instanceof HTMLLIElement)) {
      throw new TypeError(`Bubble template ${kind} must hold an <li>`);
    }

    required(li, "[data-text]").textContent = text;

    return li;
  };

  // Adds the sender's bubble; only the newest outgoing one keeps a status.
  const sent = (from: Side, text: string) => {
    const { log } = phones[from];

    for (const old of log.querySelectorAll("[data-status]")) {
      old.remove();
    }

    const li = bubble("out", text);
    log.append(li);

    return required<HTMLElement>(li, "[data-status]");
  };

  const land = (from: Side, text: string, status: HTMLElement) => {
    phones[other(from)].log.append(bubble("in", text));
    status.textContent = "delivered";
    count += 1;
    delivered.textContent = String(count);
  };

  // One pass: type, send, fly and land each line, hold the finished chat,
  // then fade both screens out. Returns the steps and the pass length.
  const pass = () => {
    const steps: Step[] = [];
    let at = 900;

    const step = (delay: number, run: () => void) => {
      at += delay;
      steps.push({ at, run });
    };

    for (const { from, text } of SCRIPT) {
      const { draft } = phones[from];
      let status: HTMLElement | undefined;

      // Type, with a little human unevenness.
      for (let i = 1; i <= text.length; i += 1) {
        step(28 + Math.random() * 40, () => {
          draft.textContent = text.slice(0, i);
        });
      }

      step(350, () => {
        draft.textContent = "";
        status = sent(from, text);
        onSend(from);
      });

      step(FLIGHT * 1000, () => {
        if (status) {
          land(from, text, status);
        }
      });

      at += 1500;
    }

    step(3000, () => {
      for (const { log } of screens) {
        log.style.opacity = "0";
      }
    });

    step(500, () => {
      for (const { log } of screens) {
        log.replaceChildren();
        log.style.opacity = "";
      }
    });

    return { steps, end: at };
  };

  let timers: ReturnType<typeof setTimeout>[] = [];

  const play = () => {
    const { steps, end } = pass();

    timers = steps.map(({ at, run }) => setTimeout(run, at));
    timers.push(setTimeout(play, end));
  };

  // Start from empty screens (a remount after the motion setting changes).
  for (const { log, draft } of screens) {
    log.replaceChildren();
    log.style.opacity = "";
    draft.textContent = "";
  }

  delivered.textContent = "0";

  if (still) {
    for (const { from, text } of SCRIPT) {
      land(from, text, sent(from, text));
    }
  } else {
    play();
  }

  return () => {
    for (const id of timers) {
      clearTimeout(id);
    }
  };
};
