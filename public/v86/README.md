# v86 firmware and emulator artifacts

Six files, four of which are committed and two of which are derived.

## Committed

Two pairs of BIOS images an emulated PC boots, copied verbatim from [copy/v86]
at commit `f3d4472`, which is the commit the `v86` npm dependency in
`package.json` is built from.

| file | sha256 |
| --- | --- |
| `seabios.bin` | `73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98` |
| `vgabios.bin` | `a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880` |
| `bochs-bios.bin` | `9535026e142f25cca520c2bbddaa7808e4a13d19e2a7a5651e6601e695cba442` |
| `bochs-vgabios.bin` | `8a1caca6760b2997f399403844e2a22b651ec48715f88f709d094f7ae46dd004` |

Almost every machine boots the first pair. The second pair exists because
Windows 3.x asks the firmware what the machine is and picks an operating mode
from the answer: under SeaBIOS this disk runs in standard mode, where a DOS
session is a protected-mode round trip through 16-bit call gates the emulator
does not implement and hangs in; under the Bochs BIOS the same disk runs in 386
enhanced mode, where a DOS session is a virtual-8086 machine and works. Which
pair a guest boots is `GuestSpec.firmware` in `src/runtime/guests.ts`.

They are vendored rather than fetched because the npm package does not ship
them and the image host does not serve them — the alternative is a third CDN in
the path of every boot, for 273 KB that never changes. None of them is
requested at page load; the first fetch of any is the first boot of an
emulated machine.

`seabios.bin` is [SeaBIOS](https://www.seabios.org/), `vgabios.bin` is
[VGABIOS](https://github.com/qemu/vgabios), and the `bochs-` pair is the BIOS
and VGA BIOS from [Bochs](https://bochs.sourceforge.io/). All are LGPL, and
`COPYING.LESSER` beside them is the licence text as distributed with them; the
corresponding sources are at the upstream projects and in [copy/v86]'s `bios/`
directory, which records the exact builds these blobs came from.

## Derived

`v86.wasm` and `v86-fallback.wasm` are copied out of `node_modules/v86/build`
by `scripts/build-v86.mjs`, which `npm run assemble` runs. They are not
committed — see `.gitignore`.

They are copied rather than imported through the bundler because v86 finds the
fallback build by string-replacing `v86.wasm` in the path it was handed, and a
content-hashed name breaks that: the browsers that need the fallback would get
a 404 and an error naming the wrong cause.

[copy/v86]: https://github.com/copy/v86
