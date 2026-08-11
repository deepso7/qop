# QOP

qop is a simple, minimal and secure messaging app built on top of [minip2p](https://minip2p.com).

## What makes QOP special?

Polished UI and super intuitive UX. Secure and p2p by default.

### 1. Open at the core

Completely open source and self hostable.

### 2. Performance without compromise

P2P and fully decentralised apps can easily become complicated and difficult to use. QOP stays simple and intuitive without compromising decentralisation, permissionlessness, or performance.

## Coding Preferences

- Prefer concise, simple solutions over clever or heavy abstractions. Channel "YAGNI" principles and avoid over-engineering.
- Typesafety is useful, take advantage of it.
- If a substantially simpler approach exists, use it or surface it clearly.
- Comments are a great way to clarify functionality and how code is used. Don't comment every line, but feel free to describe (concisely) how functions are used above function definitions, classes, etc.
- Keep comments up to date! When making changes, it's important to keep things in sync.
- Look for ways to reduce complexity when solving problems.
- Tests are good! Endless smoke tests, "regression tests" for feature deletions, etc., much less good. Tests should be focused, not slop.

## Coding preferences (Typescript focused)

- `any` is the enemy. Inferred types are our friend. Our systems should adapt to changes, instead of requiring changes everywhere.
- If your TS code looks like a Python dev wrote it, it is bad TS code.
- Avoid one-line functions that are just casting wrappers.
- Write TypeScript in ways that Matt Pocock and Theo would be proud of.
- Prefer Effect for application services, concurrency, resource management, and typed errors; don’t introduce it into trivial pure code.

## Don'ts

- Killing processes: Never use `pkill -f`, `pgrep | kill`, or kill a PID found by matching a name, path, or worktree string. Kill only a PID you captured when starting the process, or the listener returned by `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`. Before killing a port owner, confirm its working directory with `lsof -a -p <pid> -d cwd -Fn`. Use `kill <pid>` first; use `kill -9 <pid>` only if termination fails.

## Questions are read-only

- A question is a request for an answer, not for changes. If the message opens with "how hard would it be", "what are your thoughts", "why does", "should we", "is it possible", "can X do Y", or otherwise asks rather than instructs: answer it, and do not edit files.
- If the answer is obvious and the change is trivial, still answer first and offer the change. Ask before making it.

## EXPO

- Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ and relevant skills before writing any code.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect/LLMS.md` first and inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design.
