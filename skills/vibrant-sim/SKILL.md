---
name: vibrant-sim
description: Bring up a real Linux, macOS, or Windows desktop, or an Android, iOS, watchOS, tvOS or visionOS simulator, on GitHub Actions; drive it (tap, type, screenshot, read the accessibility tree, record video) and produce an evidence package a human can sign off. Use when a change needs checking on a real screen, when you need to see what an app looks like when it runs, when a smoke test needs a GUI, when something only reproduces on another platform or device, or when the user asks to verify something before release.
---

# vibrant-sim

You get a whole machine with a screen, on demand, for a few minutes. The person
who asked can watch the same screen in their browser while you drive it.

Targets:

| | |
|---|---|
| desktops | `linux`, `macos`, `windows` |
| simulators | `android`, `ios`, `watchos`, `tvos`, `visionos` |

## When to reach for this

- A change affects what something looks like or how it behaves when launched.
- A bug only reproduces on another operating system.
- You want to verify a release on a real desktop before it ships.
- Automated checks pass but nobody has actually looked at the thing.

Do not use it for work a unit test covers. A session costs runner minutes.

## Start a session

```bash
vsim session start --os linux       # or macos, windows
vsim session start --os android     # or ios, watchos, tvos, visionos
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
you are not guessing from a screenshot.

How good that tree is depends on the target:

- **Android** is the best of them. uiautomator returns text, resource ids,
  bounds and whether each node is tappable. Use `centre` from a node instead of
  reading coordinates off a screenshot.
- **Windows and macOS** expose a real tree through UI Automation and System
  Events: window titles, positions, sizes.
- **Plain X11** only lists windows, so fall back to a screenshot.
- **Apple simulators expose nothing from outside.** Apple hands an app's
  accessibility tree to XCUITest and nowhere else, so on `ios`, `watchos`,
  `tvos` and `visionos` you have to work from the screenshot. `vsim tree` tells
  you which device and which apps are installed, and nothing more.

On a simulator, coordinates are device pixels, the same ones the screenshot is
in. On a desktop they are screen pixels.

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
- **Android only runs on x64 Linux.** It needs KVM, which `ubuntu-24.04-arm`
  does not have and hosted Windows cannot provide. A session installs the udev
  rule that makes KVM usable; without it the emulator is two to three times
  slower.
- **An Android session takes several minutes to come up** because it downloads
  a system image and boots. Start it early, and do not start one for a question
  a unit test answers.
- **Detect which simulator runtimes exist; never pin one.** GitHub keeps only
  the last three Xcode releases' runtimes and prunes them monthly, and an SDK
  being installed does not mean its runtime is. `vsim session start --os ios`
  picks the newest available and tells you if none is.
- **macOS costs 10x Linux** on a private repository. Public repositories are free.
- **A job dies at 6 hours.** That is the hard ceiling for a session.
- **Never put the watch URL or the pairing key in a log, a commit, or an issue.**
- **Detect capabilities at runtime**; do not pin a simulator runtime or an Xcode
  version in a workflow. GitHub deletes old runtimes every month.
