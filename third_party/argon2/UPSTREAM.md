# Vendored: Argon2 reference implementation

- Source: https://github.com/P-H-C/phc-winner-argon2, tag `20190702`, commit `62358ba2123abd17fccf2a108a301d4b52c01a7c`.
- License: CC0 1.0 or Apache 2.0, at your option (`LICENSE`).
- Files: `include/argon2.h`; `src/argon2.c`, `core.c`, `core.h`, `encoding.c`, `encoding.h`, `opt.c`, `ref.c`, `thread.c`, `thread.h`; `src/blake2/blake2.h`, `blake2b.c`, `blake2-impl.h`, `blamka-round-opt.h`, `blamka-round-ref.h`.
- Not modified. The WebAssembly SIMD variant of `opt.c` and its round header are generated from these files at build time by `scripts/build-pow.mjs`, which stops if the upstream files no longer match what it expects.
- Approved as a dependency on 9 October 2026 (D17).
