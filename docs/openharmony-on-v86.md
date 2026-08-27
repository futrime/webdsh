# OpenHarmony on the emulated PC

**It cannot boot, and the reason is architecture rather than effort.** Checked
by `npm run openharmony:check`, which re-reads every fact below from the place
that decides it and fails if any of them stops being true.

This document exists because "add OpenHarmony to the machine list" is a
reasonable thing to ask for and the answer is not obvious. The machine list
already holds 128 operating systems, several of them far more obscure than
OpenHarmony, so the question is fair — and the answer is that all 128 have one
thing in common that OpenHarmony does not.

## The three reasons

**OpenHarmony has no 32-bit x86 target.** `openharmony/device_qemu` — the
repository that holds every board OpenHarmony emulates — carries eight:
`SmartL_E802` (C-SKY), `arm_mps2_an386` (Cortex-M4), `arm_mps3_an547`
(Cortex-M55), `arm_virt`, `esp32` (Xtensa), `riscv32_virt`, `riscv64_virt`,
and `x86_64_virt`. Exactly one of those is an x86, and it is 64-bit.

**Neither kernel has an x86 port to build one from.** `kernel_liteos_a/arch`
holds `arm` and nothing else. `kernel_liteos_m/arch` holds `arm`, `csky`,
`risc-v` and `xtensa`. There is no x86 code in either, so a 32-bit x86 target
is not a configuration that exists somewhere unbuilt — it is a port nobody has
written.

**v86 cannot run the one x86 target there is.** The emulator this build
vendors states its own limit in its Readme: its instruction set is "around
Pentium 4 level", it lists "64-bit extensions" among the features it does not
implement, and it says plainly that "64-bit kernels are not supported". There
is no flag for this and no image that works around it; long mode is simply not
implemented.

Any one of the three would be enough on its own.

## Even the best case is not what was wanted

It is worth following the `x86_64_virt` target far enough to see where it
would lead if v86 could run it, because that changes what "solve this later"
is worth.

That target is the **standard system on a Linux kernel**, built with
`./build.sh --product-name qemu-x86_64-linux-min`, and its own tutorial says
it runs on QEMU's `microvm` machine and needs `qemu-system-x86_64` 5.1 or
later. `microvm` is a virtio-mmio machine with no PCI and no legacy BIOS boot
path; v86 emulates a PC/AT with PCI, a BIOS and IDE, and has no virtio-mmio at
all. So even a hypothetical 32-bit build of that target would be built for a
machine this emulator does not provide — a fourth reason, hiding behind the
first three.

And the two products that target it are named `qemu-x86_64-linux-min` and
`qemu-x86_64-linux-headless`. The second is the one with the application
framework, and *headless* is the operative word: there is no graphical
OpenHarmony on x86 QEMU to reach even on real hardware-assisted QEMU. The
graphical OpenHarmony people actually use is an ARM image, in the emulator
that ships with the vendor's IDE.

So the honest summary is that the GUI was never on the table for this route,
and the CLI fallback is blocked by the architecture.

## What would have to change

In rough order of how likely each is to happen without this repository doing
anything:

1. **Upstream adds a 32-bit x86 board.** Then the remaining work is
   `src/runtime/guests.ts` plus a disk, which is the same work every other
   guest needed. `npm run openharmony:check` fails the day this happens, which
   is the whole reason it exists.
2. **v86 implements long mode.** This has been asked for upstream for years
   and is a very large piece of work; it would also only get as far as the
   `microvm` problem above.
3. **This deployment gains a second emulator** — QEMU compiled to WebAssembly,
   which can emulate ARM and RISC-V and which this page could host, because
   the page is already cross-origin isolated and so already has
   `SharedArrayBuffer`. That is the only route that reaches a *graphical*
   OpenHarmony. It is also a new runtime alongside `src/runtime/v86.ts`, of a
   size comparable to the browser machine, and it is not a change to v86
   support — it is a fourth machine.

Option 3 is the one that would actually deliver what was asked for. Nothing in
this repository blocks it; it simply was not built here.

## What this repository does instead

Nothing pretends otherwise. There is no OpenHarmony row in the machine picker,
because a row that can only ever fail is the thing `src/runtime/guests.ts` and
`src/host/vm-tools.ts` are both written to avoid — a machine offered to a
model or a person that answers every request with the same failure costs more
than its absence. A guest that merely needs a disk is listed and says so; a
guest that cannot execute its own instructions is not a guest.
