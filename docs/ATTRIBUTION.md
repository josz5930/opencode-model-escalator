# Attribution & Licensing

This document is the single source of truth for **third-party attribution** and the
**licensing** of `opencode-model-escalator`. It exists because the plugin is built directly on
two upstream projects that ship under **different** licenses, and the difference between them
governs what we are allowed to copy.

> **Read this before reusing any upstream code.** One upstream is permissive (MIT) and may be
> forked into this project; the other is copyleft (GPLv3) and its **code must not be copied** —
> only its ideas. Getting this wrong changes the license of the entire plugin.

## Prior art and what we take from each

| Upstream project | Author | License | What we reuse | Boundary |
|------------------|--------|---------|---------------|----------|
| [`@shutovks/opencode-model-fallback`](https://github.com/ShutovKS/opencode-model-fallback) | ShutovKS | **MIT** | **Code** — the same-session replay engine and the `pendingModel` / `inFlight` guard patterns are forked/adapted. | Permissive. May be copied and modified. **Must** retain the MIT copyright + license notice (see below). |
| [`opencode-auto-resume`](https://github.com/Mte90/opencode-auto-resume) | Mte90 | **GPL-3.0** | **Concepts only** — stall / loop / hallucination detection *ideas* and the idle-session cleanup *approach*. | Copyleft. **No source code, no verbatim structures** are copied. Ideas and behaviors are not copyrightable; the implementation here is independent and original. |

The novel contribution of this project — the Category B capability circuit-breaker ("same
logical failure across repair cycles → next, stronger model") — is original work.

## Why the GPLv3 boundary is a hard invariant

`opencode-auto-resume` is licensed under the **GNU General Public License v3**, a *copyleft*
license: any derivative work that incorporates its code must itself be released under GPLv3.
This plugin is intended to ship under a **permissive (MIT)** license (see below), which is
**incompatible** with pulling in GPLv3 code.

Therefore, as a non-negotiable build rule:

- **DO** re-implement stall/loop/idle-cleanup *concepts* from scratch, in our own code, informed
  only by the observable behavior and public documentation of `auto-resume`.
- **DO NOT** copy, paste, transliterate, or line-by-line port any source from
  `opencode-auto-resume` — not functions, not regex tables, not file structure.

If a future contributor wants to reuse actual `auto-resume` code, the entire plugin's license
must be reconsidered first. Until then, treat the GPLv3 code as read-for-understanding only.

## License of `opencode-model-escalator`

**License: MIT.** It is the natural and compatible choice because we fork MIT
code (`opencode-model-fallback`) and deliberately avoid GPLv3 code. The top-level
`LICENSE` file carries the standard MIT text and this copyright line:

```
Copyright (c) 2026 Joseph Zeng (josz5930)
```

## Required third-party notices (ship with the code)

Because we redistribute forked MIT code, the MIT license **requires** that the original
copyright and permission notice travel with it. When the plugin is packaged, include a
`THIRD_PARTY_NOTICES.md` (or `NOTICE`) file at the repository root containing the block below.
This is a redistribution obligation, not an optional courtesy.

```
This product includes software from opencode-model-fallback
(https://github.com/ShutovKS/opencode-model-fallback), used under the MIT License.

    MIT License

    Copyright (c) 2026 opencode-model-fallback contributors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
```

`opencode-auto-resume` is **not** listed as a bundled component because no code from it is
redistributed. It is credited above as design inspiration only; GPLv3 imposes no notice
obligation when its code is not used.

> Verify each upstream `LICENSE` file at the pinned commit you actually fork from before
> shipping — copyright years and holder names can change between revisions.
