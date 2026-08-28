# Third-Party Notices

`opencode-model-escalator` is licensed under the MIT License (see [LICENSE](./LICENSE)).

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

Upstream pin: patterns adapted from
[`ShutovKS/opencode-model-fallback`](https://github.com/ShutovKS/opencode-model-fallback)
as of 2026-08-26 (MIT). This tree does not vendor a verbatim file copy of that
repository; the replay / `pendingModel` / `inFlight` machinery was re-implemented
against that project's public design. Re-verify `LICENSE` at the commit you
actually copy from if you later vendor source.

---

## Design inspiration only (no code used)

### opencode-auto-resume

- **Source:** https://github.com/Mte90/opencode-auto-resume
- **Author:** Mte90
- **License:** GPL-3.0 (copyleft)
- **Usage:** **Concepts only.** Stall / loop / hallucination detection ideas and the idle-session
  cleanup approach informed this project's independent, original implementation. **No source code
  from this project is copied or redistributed.**

Because no GPL-3.0 code is incorporated, this project is not a derivative work of
`opencode-auto-resume` and carries no GPL-3.0 obligations. Copying its code would
require re-licensing this entire plugin under GPL-3.0 — see
[`docs/ATTRIBUTION.md`](./docs/ATTRIBUTION.md).
