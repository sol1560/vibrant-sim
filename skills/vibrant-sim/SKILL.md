---
name: vibrant-sim
description: Bring up a real Linux, macOS, or Windows machine with a graphical desktop on GitHub Actions, drive it (click, type, screenshot, read the UI tree, record video), and produce an evidence package a human can sign off. Use when a change needs to be checked on a real desktop, when you need to see what an app looks like when it runs, when a smoke test needs a GUI, or when the user asks to verify something before release.
---

# vibrant-sim

You get a whole machine with a screen, on demand, for a few minutes. The person
who asked can watch the same screen in their browser while you drive it.

## When to reach for this

- A change affects what something looks like or how it behaves when launched.
- A bug only reproduces on another operating system.
- You want to verify a release on a real desktop before it ships.
- Automated checks pass but nobody has actually looked at the thing.

Do not use it for work a unit test covers. A session costs runner minutes.

## Start a session

```bash
vsim session start --os linux     # or macos, windows
```

It prints a `watch` URL for the human and an `agent api` URL for you, then keeps
the machine alive until you stop it, the TTL expires, or it sits idle.

**Give the `watch` URL to the user.** That link is how they see what you are
doing. It carries the pairing key, so treat it as a secret: put it in your reply
to them, never in a commit, a log, or an issue.

## Drive it

```bash
vsim shot -o screen.png            # screenshot; look at it before you act
vsim tree                          # UI tree — cheaper and more reliable than pixels
vsim click 640 400
vsim type 'hello'
vsim key ctrl+s                    # cmd+s on macOS
vsim exec 'ls /tmp'                # a shell on the machine
vsim record start --name demo      # real video, collected as an artifact
vsim record stop
vsim session end
```

Read `vsim tree` before clicking. It gives you element names and coordinates, so
you are not guessing from a screenshot. Fall back to a screenshot when the tree
is thin, which is the case on plain X11.

## Verify and get a sign-off

Write the checks as a flow file:

```json
{
  "name": "login smoke",
  "steps": [
    { "exec": "open -a Safari https://example.com", "expect": { "code": 0 } },
    { "wait": 3000 },
    { "screenshot": "landing" },
    { "name": "page really loaded", "exec": "...", "expect": { "contains": "OK" } }
  ]
}
```

```bash
vsim run --flow checks.json --os macos
```

This produces `vsim.result.json` (what ran, what was seen, what was asserted),
`junit.xml`, `summary.md`, and the screenshots. Attach the summary to your reply
and link the evidence.

To gate a release on a person, use the `vsim-verify` workflow: the `acceptance`
environment has required reviewers, so the run stops until someone approves.
Waiting is not billed. You can approve programmatically only with a token that
belongs to a required reviewer:

```bash
vsim approve <run-id> --note "checked the login screen renders"
```

## What will bite you

- **macOS is the small machine**: 3 cores, 7 GB. Do not run anything heavy.
- **macOS costs 10x Linux** on a private repository. Public repositories are free.
- **A job dies at 6 hours.** That is the hard ceiling for a session.
- **Never put the watch URL or the pairing key in a log, a commit, or an issue.**
- **Detect capabilities at runtime**; do not pin a simulator runtime or an Xcode
  version in a workflow. GitHub deletes old runtimes every month.
