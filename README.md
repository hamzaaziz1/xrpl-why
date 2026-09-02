# xrpl-why

The XRP Ledger tells you a transaction failed. It rarely tells you why.

```
ledger said: tecPATH_DRY
```

That code means "no path found to deliver this payment." It is returned when
the destination has no trust line, when the trust line exists but the issuer
hasn't authorized it, and when either side's line is frozen. Three quite
different problems, one message, no way to tell them apart.

`xrpl-why` goes and looks.

```
summary: The issuer requires authorization and has not authorized
         this trust line.

fix: The issuer must send a TrustSet with the tfSetfAuth flag, naming
     the holder as the counterparty. Note this is the compliance
     allowlist doing its job — the holder likely has not completed KYC.

checks run:
  - read trust lines for destination rwHtVas...
  - trust line exists
  - read issuer flags: 0x00040000
```

## Install

```
npm install xrpl-why
```

## Use

```ts
import { Client } from 'xrpl'
import { explain } from 'xrpl-why'

const res = await client.submitAndWait(tx, { wallet })
const code = res.result.meta.TransactionResult

if (code !== 'tesSUCCESS') {
  const why = await explain(client, code, {
    kind: 'payment',
    account: sender.address,
    destination: recipient.address,
    amount: { currency: 'USD', issuer: issuer.address, value: '100' },
  })

  console.log(why.summary)
  for (const f of why.findings) {
    console.log(`[${f.severity}] ${f.reason}`)
    console.log(`fix: ${f.fix}`)
  }
}
```

`explain` returns:

| Field | What it is |
|---|---|
| `code` | The raw engine result, unchanged |
| `summary` | One line, safe to show a user |
| `findings` | Ranked causes — each with a `reason`, a `severity`, and a `fix` |
| `checked` | Every check that was run, in order |

`severity` is one of `certain`, `likely`, `possible`, `unknown`.

## Why `checked` exists

A diagnostic tool that just asserts a cause is something you have to trust. One
that shows its working is something you can verify.

It also fails gracefully. When the cause can't be determined, you can see
exactly how far the diagnosis got before giving up, which is usually enough to
finish the job yourself.

## What it diagnoses

**`tecPATH_DRY`** — inspects live ledger state to distinguish: no trust line,
unauthorized trust line, frozen line (sender side, destination side, or a global
freeze on the issuer), and rippling not enabled.

**`tecPATH_PARTIAL`** — a path exists but couldn't carry the full amount.

**`tecNO_PERMISSION`** — usually a permissioned-domain offer from an account
holding no accepted credential.

**`tecNO_LINE_REDUNDANT`** — a trust line change with no effect, commonly
freezing a line that was never opened.

**`tecOWNERS`** — most often `AllowTrustLineClawback` on an issuer that already
has trust lines. That flag can only be set before any issuance.

**`tecINSUFFICIENT_RESERVE`**, **`tefMAX_LEDGER`** — reserve and expiry, with
the practical consequence spelled out.

Unrecognised codes return a `severity: 'unknown'` finding and a link to the
protocol reference, rather than a guess.

## Tests

Every case is tested against live testnet — no mocks. The library's whole claim
is that it knows what the ledger actually does, and testing it against invented
responses would undercut that.

```
npm test
```

Expect around three minutes. Each case funds accounts and waits for validation.

That decision has already paid for itself. The suite falsified something this
README previously asserted: insufficient balance returns `tecPATH_PARTIAL`, not
`tecPATH_DRY`. A mock would have returned whatever I believed. The network
returned what was true.

It also caught a real bug — `explain` was only reading the destination's trust
line, so a frozen *sender* fell through every check and got a confident,
incorrect answer.

## Status

Early. The diagnoses above are tested; the surface will grow. Issues and
corrections welcome, particularly from anyone who has lost an afternoon to a
`tec` code.

MIT.
