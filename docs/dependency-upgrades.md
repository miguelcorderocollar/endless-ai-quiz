# Dependency maintenance

Issue #60 patches the web runtime advisories and updates the existing dependency
lines. Dependabot checks the root and `apps/mobile` manifests every Monday at
09:00 Europe/Madrid. Minor and patch updates share a group; majors arrive as
separate PRs so their migration requirements can be reviewed. Security updates
have their own group and are not delayed to the weekly version-update schedule.
Nothing auto-merges. The `npm audit --omit=dev` CI gate belongs to #61.

## Upgrade review

- [Next.js 16.4 release notes](https://github.com/vercel/next.js/releases/tag/v16.4.0)
  and [16.4.5 security release](https://github.com/vercel/next.js/releases/tag/v16.4.5):
  upgrade `next` and `eslint-config-next` together. No application config or
  routing changes are needed here. Verify the production build and offline PWA
  suite after upgrading.
- [Auth.js 0.41.3](https://github.com/nextauthjs/next-auth/releases/tag/%40auth%2Fcore%400.41.3)
  fixes malformed Bearer handling, provider-bound OAuth cookies, and email
  normalization. [Convex Auth 0.0.96](https://github.com/get-convex/convex-auth/blob/main/CHANGELOG.md)
  validates token/verifier ID tables and redacts debug logs. Neither release
  lists a schema migration. The local auth regression test exercises the app's
  password provider, account creation, sign-in, refresh, and rejected passwords.
  Schema and public function arguments stay unchanged for installed clients.
- Convex 1.49 requires Node 22 or newer. Use that runtime for local checks and
  deployment builds. No Convex CLI deployment command is needed for this PR.
- Mobile shares the patched auth, Convex, and Zod versions. Its React version
  remains on the Expo SDK's line; upgrading React independently would bypass
  Expo's compatibility checks.

## Separate major upgrades

Do these as individual PRs against the merged #61 workflow. Recheck current
versions and release notes at implementation time.

1. **Vitest 5 first.** The all-dependencies audit still flags Vitest 3 and its
   Tinypool worker dependency as critical, plus the mocker as moderate. This is
   outside the production-only audit. Migrate the runner/config and mock APIs,
   confirm the chosen Node runtime is supported, and run every unit test,
   including in-memory Convex auth and replay tests. Do not force a Tinypool
   major into Vitest 3 with an override. Gate on `npm audit`, `npm run test`, and
   the full verify command. The current scripts use `vitest run`, not a public
   Vitest server.
2. **ESLint 10.** Check the Next config and React/TypeScript plugin peer ranges,
   migrate flat-config rules as needed, then run lint and verify. Keep rule
   changes separate from unrelated application fixes. ESLint 9 is updated to
   its final minor here to satisfy the React plugin's peer range. The full
   audit still reports moderate minimatch/TypeScript ESLint findings.
3. **TypeScript 7.** Review compiler/config removals and supported Next, Convex,
   and Expo versions before changing the compiler. Run both root and mobile
   typechecks, tests, production build, and browser suite. Keep the mobile
   compiler on its SDK-supported version unless verified together.

The mobile audit also retains high findings in Expo Router's query-string /
decode-uri-component chain and Expo's nested Zod. Handle those with a supported
Expo SDK/router upgrade and device checks, rather than cross-major overrides or
the audit tool's suggested Expo downgrade. The directly used Zod and compatible
source-map-js/node-forge patches are updated here. A root production audit does
not cover the independent mobile lockfile.
