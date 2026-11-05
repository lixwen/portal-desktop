# Desktop Kit source handoff

2026-11-05: the Desktop Kit worktree is published to `lixwen/portal-desktop`, branch `codex/kit-platform`, based on `4b4218b`. The fork's `main` remains upstream. This handoff does not merge the feature branch into main or publish an installer.

The change includes separate Home OAuth, the local market and native confirmation, Home native hosts and authenticated control channels, preservation of legacy Plugin/App data and management authority, platform admission, paired runtime packaging and corresponding tests. Historical native and cross-service results retain their original scope in [local acceptance](KIT_LOCAL_ACCEPTANCE.md) and [Home native acceptance](KIT_HOME_NATIVE_ACCEPTANCE.md).

## Build prerequisites

The Rust `kit-installer` crate and Kit protocol libraries are maintained in the Being Home repository, outside this Desktop repository. Set `KIT_INSTALLER_SOURCE` to the reviewed crate and `HEART_PORTAL_SOURCE` to a reviewed Portal source supporting the matching Kit/Home protocols. The existing `heart-portal` submodule pin is preserved; that older pin alone does not establish support for new managed execution. Packaging validates real capabilities and both executable hashes and rejects unsupported runtimes.

```sh
npm ci
export KIT_INSTALLER_SOURCE=/path/to/reviewed/being-home/kit-installer
export HEART_PORTAL_SOURCE=/path/to/reviewed/heart-portal
npm run package
```

See [Home authentication](KIT_HOME_AUTH.md), [native host setup](KIT_HOME_NATIVE_HOST.md) and [local market setup](KIT_SELF_SERVICE.md). Credentials, user configuration, runtime databases, executable artifacts, screenshots and `output/` are excluded from this commit.

## Verification

TypeScript checking passed. The focused Kit/Home client/plugin-agent suite contains 122 scenarios. Initial checking passed 121; one stale Home host test double lacked the new `nativeFeatures()` method. The double now supplies an empty feature list, retaining the original behavior assertions. The focused rerun passed all four Home host scenarios; all 122 distinct related scenarios have now passed.

This publication does not rebuild Rust runtimes, sign an installer, run native Electron GUI checks or repeat real Home/Heart business calls. Historical evidence is not represented as new acceptance.
