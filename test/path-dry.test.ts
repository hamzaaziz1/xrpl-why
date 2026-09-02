import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client, Wallet } from 'xrpl'
import { explain } from '../src/explain.js'

const CURRENCY = 'PRP'
const tfSetfAuth   = 0x00010000
const tfSetFreeze  = 0x00100000
const asfRequireAuth   = 2
const asfDefaultRipple = 8

let client: Client
let issuer: Wallet

async function submit(tx: any, wallet: Wallet) {
  const res: any = await client.submitAndWait(tx, { wallet })
  return res.result.meta.TransactionResult as string
}

/** a holder with an open trust line; optionally authorized and funded */
async function holder(opts: { authorize: boolean; fund?: string }) {
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

function pay(from: string, to: string, value: string) {
  return {
    kind: 'payment' as const,
    account: from,
    destination: to,
    amount: { currency: CURRENCY, issuer: issuer.address, value },
  }
}

beforeAll(async () => {
  client = new Client('wss://s.altnet.rippletest.net:51233')
  await client.connect()

  const funded = await client.fundWallet()
  issuer = funded.wallet

  await submit({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: asfRequireAuth }, issuer)
  await submit({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: asfDefaultRipple }, issuer)
})

afterAll(async () => {
  await client?.disconnect()
})

describe('tecPATH_DRY has more than one cause', () => {

  it('no trust line at all', async () => {
    const { wallet: stranger } = await client.fundWallet()

    const code = await submit({
      TransactionType: 'Payment',
      Account: issuer.address,
      Destination: stranger.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '10' },
    }, issuer)

    expect(code).toBe('tecPATH_DRY')

    const why = await explain(client, code, pay(issuer.address, stranger.address, '10'))
    expect(why.findings[0].reason).toMatch(/no trust line/i)
    expect(why.findings[0].severity).toBe('certain')
  })

  it('trust line exists but is not authorized', async () => {
    const alice = await holder({ authorize: false })

    const code = await submit({
      TransactionType: 'Payment',
      Account: issuer.address,
      Destination: alice.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '10' },
    }, issuer)

    expect(code).toBe('tecPATH_DRY')

    const why = await explain(client, code, pay(issuer.address, alice.address, '10'))
    expect(why.findings[0].reason).toMatch(/requires authorization/i)
    expect(why.findings[0].severity).toBe('certain')
  })

  it('trust line is frozen by the issuer', async () => {
    const alice = await holder({ authorize: true, fund: '100' })
    const bob   = await holder({ authorize: true })

    await submit({
      TransactionType: 'TrustSet',
      Account: issuer.address,
      LimitAmount: { currency: CURRENCY, issuer: alice.address, value: '0' },
      Flags: tfSetFreeze,
    }, issuer)

    const code = await submit({
      TransactionType: 'Payment',
      Account: alice.address,
      Destination: bob.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '10' },
    }, alice)

    expect(code).toBe('tecPATH_DRY')

    const why = await explain(client, code, pay(alice.address, bob.address, '10'))
    expect(why.findings[0].reason).toMatch(/frozen/i)
  })

  it('sender does not hold enough', async () => {
    const alice = await holder({ authorize: true, fund: '5' })
    const bob   = await holder({ authorize: true })

    const code = await submit({
      TransactionType: 'Payment',
      Account: alice.address,
      Destination: bob.address,
      Amount: { currency: CURRENCY, issuer: issuer.address, value: '500' },
    }, alice)

    // insufficient balance gets its own code — NOT tecPATH_DRY
    expect(code).toBe('tecPATH_PARTIAL')

    const why = await explain(client, code, pay(alice.address, bob.address, '500'))
    expect(why.findings[0].reason).toMatch(/less than they tried to send/i)
  })

  it('reports the checks it ran', async () => {
    const alice = await holder({ authorize: false })
    const why = await explain(client, 'tecPATH_DRY', pay(issuer.address, alice.address, '10'))
    expect(why.checked.length).toBeGreaterThan(1)
  })
})
