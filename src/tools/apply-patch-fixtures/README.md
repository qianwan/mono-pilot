# ApplyPatch Fixture Set

- `original.md` is the base file for all patch cases.
- `patches/*.patch` uses `{{FILE}}` as a placeholder for the absolute target path.
- `patches/00-context-only.patch` validates baseline context matching without line hints.
- `expected/*.md` contains the expected output after applying each patch to `original.md`.