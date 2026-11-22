[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/greydi92/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/greydi92/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

# mend

`mend` applies an edit that an AI model wrote to a tree of text files, in
one of four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. It finds the lines an edit names at the first of three matching tiers
(exact, trailing-trim, full-trim; `--strict` is tier 0 only) and changes
every file or none. The whole contract is `SPEC.md` in the kit's starter;
this repository carries the implementation, `main.ts`.

Run it as `node main.ts [options] [PATCH]`, Node 22, standard library only:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is read from standard input when absent or `-`. `--check` reports
exactly what a real run would do and writes nothing. `runner.ts` is the
kit's trial runner, kept as it is; `check.ts` runs the practice set:

    node check.ts <practice.json>

Practice score: 100/100. A further 168 hand-computed edge checks covering
SPEC sentences the practice set does not show (move chains and `R`-row
conditions, empty-`O` insertions at the end of a file, `\` lines, anchor
and cursor rules, overlapping occurrences, parse-error line numbers,
unsafe paths, `--` handling) also pass.

## License

MIT — see `LICENSE`.
