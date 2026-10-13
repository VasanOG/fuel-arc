# Demo-data candidates in `fuel.db` — inspection record

**Inspected 2026-08-26 (Phase 5B-3). Nothing was written. No row was updated or
deleted. `scripts/mark-demo-rows.ts` was run in inspect mode only; `--confirm`
has never been run against this database.**

This exists because marking a row `is_demo = 1` is a judgement made from free
text, and free text is the one column in `payments` that Fuel does not always
own. The script prints candidates and refuses to write without `--confirm`
precisely so that a person can look at this evidence first. This file is that
look, so the decision does not have to be re-derived later from memory.

## What the script matches

`detail = 'demo-seed' AND is_demo = 0`, in `payments` and `approval_requests`.
`'demo-seed'` is the literal `scripts/seed-demo-day.ts` writes into every row it
creates.

**Result: 110 payments, 3 approvals. All created on 2026-08-24.**

## Payments — the whole table, for context

| status | detail | tx_hash | count |
|---|---|---|---|
| settled | `demo-seed` | present | **110 ← candidates** |
| settled | NULL | present | 48 |
| blocked | other text | NULL | 81 |
| unreconciled | other text | NULL | 27 |
| failed | other text | NULL | 1 |
| | | | **267 total, 0 currently marked demo** |

## Why the predicate alone is not proof

`payments.detail` is not always ours. `describeRejection` in
`src/payments/pay.ts` writes `JSON.parse(header).error` — a **third-party
merchant's string** — into `detail` via `markUnreconciled`. A merchant
answering `{"error":"demo-seed"}` produces a real payment that matches.

That reaches `settled`, not just `unreconciled`, because `markSettled` accepts
`unreconciled` as an input state and does **not** clear `detail`. So
"settled + `detail = 'demo-seed'`" is a combination a real payment can hold, and
110 of 110 candidates are settled. The predicate had to be corroborated.

## Category A — 90 payments, provable from the seed's own arithmetic

`settled_at - created_at = exactly 9 seconds` on all 90, which is
`seed-demo-day.ts`'s literal `Date.parse(createdAt) + 9_000`. Their `created_at`
values step at exactly `28800 / total` seconds — `stampFor`'s spread of a
seed group across an 8-hour day.

## Category B — 20 payments, seeded `unreconciled` and settled later

These are the ones that needed work. They carry the same `detail` but their
`settled_at` is **2026-08-25T19:38:44.814Z – .822Z** — twenty rows inside an
8-millisecond window, which is one bulk operation and not twenty settlements.
`markSettled` left `detail` untouched, which is why they still match.

This is exactly the shape a real merchant-rejected-then-settled payment would
have, so Category B is where the free-text read would have been wrong if it
were ever going to be.

## The corroborating evidence, which covers both categories

1. **The `tx_hash` fingerprint is decisive.** The seed writes
   `0x${randomUUID()}${randomUUID()}` with the dashes stripped, so a seeded hash
   is two UUIDv4s: hex digit 13 of each half is `4` (the version nibble) and
   digit 17 is one of `8 9 a b` (the variant nibble).

   | | payments with a `tx_hash` | matching the UUID-pair fingerprint |
   |---|---|---|
   | candidates | 110 | **110** |
   | every other payment | 48 | **0** |

   A real 32-byte settlement hash matches by chance with probability
   ≈ `(1/16 × 4/16)²` ≈ **1 in 4096**. All 110 matching and none of the 48
   real hashes matching is not a coincidence.

2. **The vendors cannot be paid.** `api.serpstack.test` and
   `api.firecrawl.test` sit under `.test`, which RFC 6761 reserves and which
   never resolves on the public internet. No real payment was made to either.

3. **The counts reproduce the seed configuration exactly.**

   | agent | vendor | candidates | `SEEDS` entry |
   |---|---|---|---|
   | research-bot | api.serpstack.test | 40 | 40 settled |
   | research-bot | api.firecrawl.test | 50 | 30 settled + 20 unreconciled |
   | race-bot | api.serpstack.test | 20 | 20 settled |

4. **Every candidate is `amount_base_units = 1000`** — `TENTH_OF_A_CENT`, one
   value, no variation.

5. **No candidate carries a `refusal_code`.**

## Approvals — a stronger guarantee than payments

`approval_requests.detail` has **no third-party write path at all**. Its only
writers are `createApprovalRequest` (called only from `src/payments/pay.ts`,
with prose Fuel composes) and `reapStaleApprovals` (two fixed strings, neither
of which is `demo-seed`). So on this table the literal could only have come from
the seed script.

All 3 candidates agree with that anyway:

- all `approved`, all decided **exactly 4 seconds** after creation — the seed's
  literal `Date.parse(createdAt) + 4_000`;
- all `amount_base_units = 1000`, both vendors under `.test`;
- scopes are `team`, `team`, `anomaly` — exactly the seed's 2 team approvals on
  serpstack and 1 anomaly approval on firecrawl, all for research-bot;
- all 3 link via `payment_id` to payments that are themselves candidates.

The rest of the table is visibly real and untouched by the predicate: 8
`consumed` and 3 `denied` with NULL detail, 4 genuine anomaly requests carrying
real baseline prose, and 2 `expired` written by the reaper.

## Any candidate that cannot be proven seeded

**None — but the distinction matters.** No candidate is unprovable. However
**20 of the 110 (Category B) are not provable from the script's own predicate**
and rest entirely on the corroboration above, chiefly the `tx_hash`
fingerprint. That gap is the argument for why this script prints ids and
refuses to write without `--confirm`, rather than being a migration nobody
watched run.

## What marking them would and would not change

- **Would not** change any accounting output. 150 `export_postings` rows link
  the 110 candidates to 6 posting lines (4 expense totalling $0.110, 2 suspense
  at $0.000), and 3 QuickBooks drafts are already posted to the sandbox.
  Nothing in `src/accounting/`, `src/db/postings.ts` or `src/quickbooks/` reads
  `is_demo` — verified by grep. Marking is a display fact, not a financial one.
- **Would** let the dashboard label them honestly as demonstration data, and
  would let `seed-demo-day.ts` replace them on a re-seed. Its deletes are
  `WHERE is_demo = 1 AND created_at LIKE ?`, so **until this is run, a re-seed
  of 2026-08-24 will not clear the existing rows and will duplicate the day.**

## The decision

Running `npx tsx scripts/mark-demo-rows.ts --confirm` is the operator's call and
has not been made. The evidence above is what it should be made on.

## Appendix — the exact candidate ids (inspected 2026-08-26, nothing written)

Captured from `npx tsx scripts/mark-demo-rows.ts` in inspect mode. These are the
rows a `--confirm` run would set `is_demo = 1` on, and nothing else. Recorded here
so the operator making that call can diff this list against what the script prints
on the day, rather than trusting that nothing changed in between.

### approval_requests — 3

```
404ed45b-73b9-47b7-8ee3-507dc7a4ff6e
b21288e3-f42f-409a-9db5-a10c6c3f1a69
1b474756-3647-4ad4-851a-04bd70e29b8a
```

### payments — 110

```
df732b72-c995-4180-835b-669528341bfd  e27abb0e-e201-485b-adc6-ee6abc4f1c29
b3cadefe-fa9e-49ae-af28-ed093f6ceeb8  f0fbe7aa-a720-4376-9fd1-275d06018e06
676442c2-4035-4808-acae-f70b4737ff06  c1ed45fa-207f-4648-9a90-02b5441fa7b7
4f300b7f-0569-492f-8091-85f0d7c23169  324d1389-765b-4cdd-87f4-84f797185f5a
30697ac9-d8b8-4b3d-998c-63f8a766dce1  bde2e0ed-fad9-4f26-aa51-96da0f8469e7
88ed56f9-8566-42d1-b5f2-a4421d99dfc8  05637aad-874b-40cd-9611-c0719ffae85b
ba8091d0-36cc-4779-bf1a-62d3ae23c66f  7c4211f7-6616-4d82-adf6-f370b7b01514
54a7af2e-884c-44a2-82c9-b4d0f7a09b05  257dae5b-d82e-4995-994b-ab092732ec91
4529e8f4-0c44-4a0b-924a-66207291c0d8  5f0dd7dc-5923-4244-a565-9f34bec5c88a
9e3f7264-a832-4608-93d6-66b1b6edb8ee  cabe04d2-f70d-4e62-af62-ba0feadab56e
84dbf6b5-5c28-4859-ae97-4bc428c35bdc  e3a97865-b598-4994-9b30-e3b3037a3559
2c9b7b42-06f5-4813-835e-5aa65ec50d14  4fc3f9ab-2b3d-41de-9b22-8961dba429eb
d1851a7d-b81c-4390-a0a1-5894db23e25a  75f666ea-8bd3-42dc-88da-fffc3d14bb9d
f4286141-74b0-4fec-8573-5b5ce2f0bb38  b97dea6d-ee46-4fdc-836c-fa0045805f44
1c21328d-7825-4990-af77-b712acd621ff  d3dc5022-eb08-49cd-bc22-1cb5f0f87054
2da4e033-bccd-44c9-8fea-ac9ea0fa2c4e  971c90c7-ae85-407d-8cb4-4970b14dad1c
8eaca694-02cb-4b45-a4a5-c2fd9f8259d7  3cf64a44-fd70-4e62-ad56-594a68b3ec98
4fed4b28-e465-4455-86ff-8f39a9af37ee  7f653d97-cbfd-490d-ac51-57bc0c7b136c
f885f233-3725-4b29-9d9a-3c9c41c29120  d244a685-c8cb-4b9d-95a7-46a24f23b05c
c50ab3b4-30a3-4c77-a7a0-487e85b3c490  d9b1dd7a-8c67-4fe5-ab40-51136f4d4a43
1f7df253-ee9d-49ca-9e8a-cdedf9e1a486  76deee9f-bd91-4771-9e17-feb34bf24c78
52cba513-3dd9-42b7-9355-db57cc447126  3c478b46-d0fc-4149-83bf-6311c367fc0e
08f7a6d7-833d-4d64-bc82-7fe7084ca028  3f83211a-e28b-43d8-9caa-bb9e88d904de
698443fc-ef06-46e5-a78b-fb994e73b072  8dabef35-ebdd-43d4-95ba-aa4ed29b12b7
ddb1596c-ed2a-4b3a-80a4-ba4959eaccae  339a1f39-f22b-4bf5-8c8b-2f841fd9fb3d
363cb457-8a0f-4c05-8218-368009e81690  609a7206-c843-488c-a038-5fa2ec81095d
1ea715a8-ecb6-4618-b66d-7af08089d511  250f460e-6d20-4bd5-a5e0-6e68fe698023
af5230aa-ebca-47a1-9414-0fdf2fd10c78  d2a95b9d-ecb4-4285-a563-d5bb2e9c2cd3
7c3fd0c7-cc13-4a66-8b51-fbec7381b72a  886a77c4-2289-4dcf-8ed8-217e4bd48dbb
159dd78c-7623-454c-8313-037d1f38ebc1  d471cb92-4339-47aa-bced-9a467fe1c019
b3916fd0-c591-4199-a992-51a6f7ef12c8  0363d7f6-56c3-462f-a898-3f99ed1861fe
1949f967-6c5b-431c-a87c-f39e117c40ff  7ffb4f9d-9a3b-414e-9c27-f005b0b33d40
3724a18b-8810-4338-9345-b59654ac3927  3c76be67-2d87-4096-8e87-993229d9d12f
5091011d-b9cb-4b7a-979c-812c1bd0d138  f72b8e57-907d-4aa4-9a94-86b9d1135a65
21e72b9e-a62a-43ba-8886-cd494e780bc9  9a0ac80c-9741-4dac-925a-8c6c1cb75dd4
02566300-2b61-4420-afcb-15d8eed62c24  1eb1c088-0592-409e-b1b1-0faa9beb53c7
a6aa725a-1c20-45ff-bfa2-58fc3ba23cf1  099bf8a3-ebc2-4698-a546-03b082bada69
df5bc171-c47e-48d0-ba3f-710cfe53ae08  ca28d988-253e-43b8-9cf5-38f5ecbe2a82
0e86f83b-0969-4efc-bdcf-01b41ac9765e  8dc4e3de-a94f-406a-930e-5b02a277f712
7c57436f-3d80-43aa-8afc-615ef7292d31  fe577c2e-2c14-4f22-991f-18b8947732e0
335c121a-63b1-4624-b152-b9f10f154981  53f001c3-c0ba-4a17-a95c-df99a0db1f22
8d96c983-f21e-4ad4-a22f-a3dc9ddde197  18e6b22f-407a-46e9-bb80-950e5ce3e049
cdb33ae1-1d9d-4fd1-9efc-89bf9b6170fa  efec7b05-3ba6-4123-a365-911255767333
425ab2bc-072d-432b-bca4-9d1f57283985  66c6fdd2-9c46-42d6-963f-d0ba4495b60f
e133b146-cf30-4cf0-a28c-fb11fb2f4fce  4ab1eb9f-8850-4b04-b497-00d96b0a910c
4d4e0918-1e1c-457c-b15d-0ff1dc9dc3e8  49013465-eaaf-4248-98fc-3c144187ed4b
22a72ab4-180d-49e5-a047-91bc178a3171  767f9b63-480d-4cb6-8e98-e2fa111be4d9
ba437e3d-6789-4a1c-9dad-303f9a7d2c3c  9be11db3-3a7c-41a9-b79e-d614aa40f26e
bd1d67b5-6a09-4bb5-b7f1-73bfafae7077  3228d237-f1d6-4e97-9eea-abef2cf675ea
b56c5610-64f2-42ae-a241-9ba046e17f44  a03cd0fc-c8d7-4e9d-bef2-18daa148d5c1
0df807af-8d30-49d6-87fe-3de1080d7432  dd6c1dba-edb4-4a24-bb96-67714b127238
aea9eab0-d6be-4549-96de-d1dd991294d3  7a371309-dea1-4f0b-9209-ec51d678f4ee
40a59ec0-0116-43dd-9a7f-e63500ed4132  8bc74704-c839-41e0-a06b-60ecdbd16d09
91f889f1-913e-4402-aee7-00b7a06c7f8c  b0f8acee-0c4d-4073-a96c-91079572e10f
c8f16fc6-77c4-4334-8b57-76852857226e  773bd483-e5d1-4320-a47a-c4d234a971c9
```
