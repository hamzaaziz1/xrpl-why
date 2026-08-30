import { Client } from 'xrpl'
import { explain } from './explain.js'

const client = new Client('wss://s.altnet.rippletest.net:51233')
await client.connect()

const { wallet: issuer } = await client.fundWallet()
const { wallet: holder } = await client.fundWallet()

console.log(`\nissuer: ${issuer.address}`)
console.log(`holder: ${holder.address}\n`)

await client.submitAndWait({
  TransactionType: 'AccountSet', Account: issuer.address, SetFlag: 2,
}, { wallet: issuer })

await client.submitAndWait({
  TransactionType: 'TrustSet',
  Account: holder.address,
  LimitAmount: { currency: 'PRP', issuer: issuer.address, value: '1000' },
}, { wallet: holder })

const res = await client.submitAndWait({
  TransactionType: 'Payment',
  Account: issuer.address,
  Destination: holder.address,
  Amount: { currency: 'PRP', issuer: issuer.address, value: '100' },
}, { wallet: issuer })

const code = (res.result.meta as any).TransactionResult
console.log(`ledger said: ${code}\n`)

const why = await explain(client, code, {
  kind: 'payment',
  account: issuer.address,
  destination: holder.address,
  amount: { currency: 'PRP', issuer: issuer.address, value: '100' },
})

console.log(`summary: ${why.summary}\n`)
for (const f of why.findings) {
  console.log(`  [${f.severity}] ${f.reason}`)
  console.log(`   fix: ${f.fix}\n`)
}
console.log('checks run:')
for (const c of why.checked) console.log(`  - ${c}`)

await client.disconnect()
