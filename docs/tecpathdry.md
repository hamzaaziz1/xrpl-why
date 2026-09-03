# tecPATH_DRY means five different things

If you've built anything on the XRP Ledger that moves issued tokens, you've hit
this:

```
tecPATH_DRY
```

The docs will tell you it means no path was found to deliver the payment. That's
accurate and almost useless, because "no path" is what the payment engine says
when it gives up, not why it gave up.

I spent a week building a regulated-asset issuance demo on XRPL and hit this
error in five structurally different situations. Same code every time. Here they
all are, with a minimal reproduction for each, and a checklist at the end for
narrowing it down.

Everything below is verified against testnet. I got the count wrong twice while
writing this — first I thought four, then three — so if you find a sixth, I'd
like to know.

## 1. The destination has no trust line

The most common one, and the only one people usually know about.

XRPL tokens are opt-in. You can't push an issued token at an account that hasn't
said it's willing to hold it.

```ts
const { wallet: stranger } = await client.fundWallet()

await client.submitAndWait({
  TransactionType: 'Payment',
  Account: issuer.address,
  Destination: stranger.address,
  Amount: { currency: 'PRP', issuer: issuer.address, value: '10' },
}, { wallet: issuer })
// tecPATH_DRY
```

**How to check:** `account_lines` on the destination, filtered by currency and
issuer. If there's no matching line, that's your answer.

**Fix:** the destination submits a `TrustSet`. Only they can do it — the issuer
can't create it on their behalf.

## 2. The trust line exists but isn't authorized

If the issuer has `RequireAuth` set, a trust line is inert until the issuer
blesses it. The line is there, the limit is set, and nothing can move.

```ts
// issuer has asfRequireAuth (2)
// holder has submitted TrustSet
// issuer has NOT authorized it

await client.submitAndWait({
  TransactionType: 'Payment',
  Account: issuer.address,
  Destination: holder.address,
  Amount: { currency: 'PRP', issuer: issuer.address, value: '10' },
}, { wallet: issuer })
// tecPATH_DRY
```

This one is worth dwelling on if you're building anything compliance-related,
because a failed KYC check surfaces to your user as "no liquidity." That's a
terrible error message for what is actually "you haven't been approved yet."

**How to check:** read the issuer's `Flags` via `account_info` and test for
`lsfRequireAuth` (`0x00040000`). Then check the trust line for `peer_authorized`.

**A trap here:** on `account_lines`, the field named `authorized` means *this
account authorized the counterparty*. Querying the holder, that's the holder
authorizing the issuer — the opposite of what you want. `peer_authorized` is the
one that tells you the issuer authorized the line. Trust lines are two-sided
objects and every field has a direction.

**Fix:** the issuer submits a `TrustSet` with `tfSetfAuth`, naming the holder as
counterparty.

## 3. The line is frozen — on either side

An issuer can freeze an individual holder. A holder can freeze their own side.
Either blocks the transfer.

```ts
// issuer freezes alice
await client.submitAndWait({
  TransactionType: 'TrustSet',
  Account: issuer.address,
  LimitAmount: { currency: 'PRP', issuer: alice.address, value: '0' },
  Flags: 0x00100000, // tfSetFreeze
}, { wallet: issuer })

// alice tries to pay bob
// tecPATH_DRY
```

This is the one that caught my own diagnostic code. I was reading the trust line
on the *destination* — checking whether bob was frozen. Bob was fine. Alice was
frozen, and I never looked.

**How to check:** read trust lines for both the sender and the destination.
`freeze_peer` means the issuer froze that line; `freeze` means the account froze
its own side. Check both fields on both accounts.

Alice's balance is completely intact while frozen, incidentally. She just can't
move it. So a balance check tells you nothing here.

## 4. Global freeze on the issuer

The issuer can freeze everything at once, which blocks every holder
simultaneously without touching any individual trust line.

```ts
await client.submitAndWait({
  TransactionType: 'AccountSet',
  Account: issuer.address,
  SetFlag: 7, // asfGlobalFreeze
}, { wallet: issuer })

// any holder-to-holder payment now:
// tecPATH_DRY
```

**How to check:** `lsfGlobalFreeze` (`0x00400000`) in the issuer's account flags.

This one is invisible if you're only looking at trust lines. Every line will
look healthy — authorized, unfrozen, funded — and nothing will move.

## 5. DefaultRipple isn't enabled

The subtlest one, and the only one that isn't a compliance control.

Without `DefaultRipple` on the issuer, tokens can only move between the issuer
and a holder. Holder-to-holder transfers fail. Which means no secondary market at
all, and no obvious reason why.

```ts
// issuer does NOT have asfDefaultRipple (8)
// alice is authorized and holds 100 PRP
// bob is authorized

// alice -> bob
// tecPATH_DRY
```

Every trust line involved is healthy. Nothing is frozen. Alice has the balance.
And it still fails.

**How to check:** `lsfDefaultRipple` (`0x00800000`) on the issuer.

**Fix:** the issuer sets `asfDefaultRipple`. Note this is a policy decision, not
a bug — an issuer that deliberately wants a closed system where all transfers
route through them would leave it off.

## The one that isn't tecPATH_DRY

Insufficient balance returns **`tecPATH_PARTIAL`**, a different code entirely.

I originally wrote — in a public README, no less — that insufficient balance was
one of the `tecPATH_DRY` causes. A test against the real network corrected me.

The boundary is exact. Holding 100 and sending 100 succeeds. Sending 101 returns
`tecPATH_PARTIAL`, meaning a path was found but couldn't carry the full amount.

If you want partial delivery to be acceptable, set `tfPartialPayment` and it
succeeds with less delivered.

## A checklist

In this order, because each step rules out the ones after it:

1. **Destination trust line exists?** `account_lines` on the destination →
   no match means cause 1.
2. **Issuer requires auth, and has it authorized?** `account_info` on the issuer
   for `lsfRequireAuth`, then `peer_authorized` on the line → cause 2.
3. **Either line frozen?** `freeze` and `freeze_peer` on *both* sender and
   destination lines → cause 3.
4. **Global freeze?** `lsfGlobalFreeze` on the issuer → cause 4.
5. **DefaultRipple off?** `lsfDefaultRipple` on the issuer → cause 5.

Cause 5 is the only one reached by elimination rather than positive evidence.
Everything else you can point at directly.

Four ledger reads gets you a definitive answer in every case. The information
was always available — it just isn't in the error.

## Why the error is like this

Not a criticism, mostly. The payment engine's job is to find a route that
delivers the amount. It tries, fails, and reports that it failed. It doesn't
carry a diagnostic trail of everything it considered and rejected, because that
would be expensive to compute and larger than the transaction result itself.

The information is one query away. It's just on the caller to go get it.

## I packaged this up

I got tired of doing those four reads by hand, so it's a library now:
[`xrpl-why`](https://www.npmjs.com/package/xrpl-why).

```
npm i xrpl-why
```

```ts
const why = await explain(client, code, {
  kind: 'payment',
  account: sender.address,
  destination: recipient.address,
  amount: { currency: 'PRP', issuer: issuer.address, value: '100' },
})

console.log(why.summary)
// "The issuer requires authorization and has not authorized this trust line."
```

It returns the list of checks it ran alongside the diagnosis, so when it's wrong
you can see why rather than just being misled more confidently.

Early days, and the checklist above is more valuable than the package. Use
whichever.

---

*All five cases have integration tests against testnet in
[the repo](https://github.com/hamzaaziz1/xrpl-why). No mocks — the whole point is
knowing what the ledger actually does, and I'd already been wrong twice about
that.*
