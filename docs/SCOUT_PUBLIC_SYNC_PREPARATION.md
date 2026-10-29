# Scout — public-result connection preparation

Experimental copy based on `8e462e4`; no source-branch changes or new commits.
The existing Android UI, file import and fictional v1 reception stay in place.

## What this prototype adds

- A pure local exporter for the `research.json` v11.1 shape. It reuses the
  existing quote/cost projection and strict mobile-card validator.
- A version 2 display envelope with opaque engine/research IDs, revision,
  timestamp, explicit data origin, no execution authority and no claimed
  authentication. The v1 parser still refuses this envelope.
- A trusted-host release gate: inspect the local candidate, then explicitly
  approve its exact SHA-256 and declared source URLs. A digest binds approval;
  it does not establish publicness, provenance, authorization or secrecy.
  Never automatically approve real data using the review helper.
- A read-only transport preparation, disabled by default. Only an injected
  in-memory port at the fixed `scout-sync.invalid` endpoint is supported.
  Real mode/URLs/credentials are refused. There is no fetch or server.
- A separate receiver/store factory reusing the SQLite singleton storage.
  When eventually wired to UI, use a dedicated experimental database, not
  the v1 or manual-opportunity databases. This factory is not wired today.
- Simulated-device authorization tests and actual SQLite close/reopen tests.

The exact old mobile parser was moved to a shared module and re-exported from
its existing Android path. Existing validators and screens retain their APIs.
No account, pairing, credential vault, TLS stack or production server exists.

## Bounds and deliberate restrictions

Raw file: 131072 bytes, at most ten sources and three opportunities. Envelope:
12000 UTF-8 bytes. Public display URLs require canonical HTTPS DNS names,
without query/fragment/userinfo, IP literals or local names. No URL is opened.
Unknown display fields, unsafe flags, invalid costs/quotes and known private
values are refused. Internal fields and full page text are never serialized.

Input publicness ultimately needs a trusted content review. Known-secret
matching cannot detect every unknown personal datum. The exported label and
approval hash are not cryptographic source authentication.

The simulated transport uses one bodyless GET, no redirect/cookie handling,
JSON only, no compression, bounded UTF-8 decoding, 64 chunks, 12000 bytes and
at most 1000 ms including credential lookup. These are simulation-port
requirements; a future native implementation must actually enforce them.

Receipt checks engine identity, freshness, revision rollback/conflicts and
serializes calls within one receiver instance. Offline reads revalidate the
stored format but do not expire its content. Multi-instance atomic revision
updates, persistent pairing, active cancellation and secure cache retirement
remain future work before any real activation.

## Offline demonstration

With Node 22 and the existing locked dependencies, from the copy root:

```bash
node node_modules/typescript/bin/tsc
NODE_OPTIONS="--import=$PWD/scripts/scout-offline-test-guard.mjs" \
  node --import tsx scripts/scout-public-sync-demo.mts
```

The demo is fixture-only. It approves only its authored fixture, invokes an
in-memory engine port, saves in a temporary SQLite file, closes/reopens it,
then reloads with the transport disabled. No listener or network is needed.

The deliverable validation directory also provides a stricter verification
guard blocking network/listen/remote DNS; use it for the documented targeted
test campaign. Do not run the complete Scout suite under this task's no-port
restriction: `scout-local.test.ts` contains an actual loopback listener.

No APK/device test or successful Hermes export is claimed. Expo CLI startup
was stopped by the strict guard when its event logger attempted a local IPC
listener. TypeScript and the no-network targeted tests are the completed
validation evidence; see the accompanying report for exact counts.
