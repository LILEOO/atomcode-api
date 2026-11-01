# Attribution and source

This repository contains an adapted copy of protocol code from
[`aqiu817/magpie-atomcode`](https://github.com/aqiu817/magpie-atomcode),
commit `9d2014927b9de0d5d1308f6329fcaf98cfcbc346`, licensed under MIT.

The copied modules implement:

- `atomcode-signing-v1` request signing
- AtomGit OAuth broker calls
- CodingPlan model, status and claim calls
- AtomCode client-version tracking
- metadata response size limits and endpoint validation

The upstream project credits the independent
[`Atom2Api`](https://github.com/cnluminous/Atom2Api) implementation for the
signing algorithm and OAuth/CodingPlan protocol facts. Its MIT-licensed test
vector is retained as a compatibility fixture.

This project is unofficial and is not affiliated with or endorsed by AtomGit or
AtomCode.
