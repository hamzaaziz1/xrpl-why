import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client, Wallet } from 'xrpl'
import { explain } from '../src/explain.js'

const CURRENCY = 'PRP'
const tfSetfAuth  = 0x00010000
const asfRequireAuth    = 2
const asfDefaultRipple  = 8
const asfGlobalFreeze   = 7

let client: Client

async function submit(tx: any, wallet: Wallet) {
  const res: any = await client.submitAndWait(tx, { wallet })
  return res.result.meta.TransactionResult as string
}

/** a fresh issuer with whichever flags you ask for */
async function newIssuer(flags: number[]) {
  const { wallet } = await client.fundWallet()
  for (const f of flags) {
    await submit({ TransactionType: 'AccountSet', Account: wallet.address, SetFlag: f }, wallet)
  }
  return wallet
}

async function newHolder(issuer: Wallet, opts: { authorize: boolean; fund?: string }) {
  const { wallet } = await client.fundWallet()
  await submit({
    TransactionType: 'TrustSet',
    Account: wallet.address,
    LimitAmount: { currency: CURRENCY, issuer: issuer.address, value: '1000000' },
  }, wallet)

  if (opts.authorize) {
    await submit({
      TransactionType: 'TrustSet',
      Account: issuer.address,
      LimitAmount: { currency: CURRENCY, issuer: wallet.address, value: '0' },
      Flags: tfSetfAuth,
    }, issuer)
  }

  if (opts.fund) {
    await submit({
      TransactionType: 'Payment',
      Account: issuer.address,
      Destination: wallet.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: opts.fund },
    }, issuer)
  }
  return wallet
}

function pay(issuer: string, from: string, to: string, value: string) {
  return {
    kind: 'payment' as const,
    account: from,
    destination: to,
    amount: { currency: CURRENCY, issuer, value },
  }
}

beforeAll(async () => {
  client = new Client('wss://s.altnet.rippletest.net:51233')
  await client.connect()
})

afterAll(async () => { await client?.disconnect() })

describe('edge cases — what code does the ledger actually return?', () => {

  it('DefaultRipple disabled: holder cannot send to holder', async () => {
    // note: NO asfDefaultRipple
    const issuer = await newIssuer([asfRequireAuth])
    const alice  = await newHolder(issuer, { authorize: true, fund: '100' })
    const bob    = await newHolder(issuer, { authorize: true })

    const code = await submit({
      TransactionType: 'Payment',
      Account: alice.address,
      Destination: bob.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '10' },
    }, alice)

    console.log(`\n[no DefaultRipple] ledger returned: ${code}`)

    const why = await explain(client, code, pay(issuer.address, alice.address, bob.address, '10'))
    console.log(`[no DefaultRipple] diagnosis: ${why.summary}\n`)

    expect(code).not.toBe('tesSUCCESS')
  })

  it('global freeze on the issuer', async () => {
    const issuer = await newIssuer([asfDefaultRipple])
    const alice  = await newHolder(issuer, { authorize: false, fund: '100' })
    const bob    = await newHolder(issuer, { authorize: false })

    await submit({
      TransactionType: 'AccountSet', Account: issuer.address, SetFlag: asfGlobalFreeze,
    }, issuer)

    const code = await submit({
      TransactionType: 'Payment',
      Account: alice.address,
      Destination: bob.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '10' },
    }, alice)

    console.log(`\n[global freeze] ledger returned: ${code}`)

    const why = await explain(client, code, pay(issuer.address, alice.address, bob.address, '10'))
    console.log(`[global freeze] diagnosis: ${why.summary}\n`)

    expect(code).not.toBe('tesSUCCESS')
  })

  it('exact balance succeeds; one over fails', async () => {
    const issuer = await newIssuer([asfDefaultRipple])
    const alice  = await newHolder(issuer, { authorize: false, fund: '100' })
    const bob    = await newHolder(issuer, { authorize: false })

    const exact = await submit({
      TransactionType: 'Payment',
      Account: alice.address,
      Destination: bob.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '100' },
    }, alice)
    console.log(`\n[exact balance] ledger returned: ${exact}`)

    const over = await submit({
      TransactionType: 'Payment',
      Account: bob.address,
      Destination: alice.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '101' },
    }, bob)
    console.log(`[one over] ledger returned: ${over}\n`)

    expect(exact).toBe('tesSUCCESS')
  })
})
