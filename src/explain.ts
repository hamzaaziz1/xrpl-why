import type { Client } from 'xrpl'
import type { Explanation, Finding, TxContext } from './types.js'

const lsfGlobalFreeze = 0x00400000
const lsfRequireAuth  = 0x00040000

/** static descriptions for codes that don't need a lookup */
const STATIC: Record<string, { summary: string; findings: Finding[] }> = {
  tecNO_PERMISSION: {
    summary: 'The account is not permitted to do this.',
    findings: [{
      reason: 'For a permissioned offer, the account holds no credential accepted by that domain.',
      severity: 'likely',
      fix: 'Issue the account a credential the domain accepts, and make sure the account has ACCEPTED it — an issued-but-unaccepted credential does not grant membership.',
    }],
  },
  tecNO_LINE_REDUNDANT: {
    summary: 'That trust line change would have no effect.',
    findings: [{
      reason: 'You tried to modify a trust line that does not exist, or set it to the value it already has.',
      severity: 'certain',
      fix: 'Create the trust line first. Freezing a line that was never opened fails this way.',
    }],
  },
  tecOWNERS: {
    summary: 'The account owns objects that block this change.',
    findings: [{
      reason: 'AllowTrustLineClawback cannot be enabled on an account that already has trust lines.',
      severity: 'likely',
      fix: 'Clawback must be set before any issuance. Use a fresh issuer account and set the flag before opening any trust lines.',
    }],
  },
  tecINSUFFICIENT_RESERVE: {
    summary: 'The account cannot afford the reserve for another ledger object.',
    findings: [{
      reason: 'Every object an account owns locks a small amount of XRP.',
      severity: 'certain',
      fix: 'Fund the account with more XRP, or delete an unused object to free its reserve.',
    }],
  },
  tefMAX_LEDGER: {
    summary: 'The transaction expired before it was validated.',
    findings: [{
      reason: 'LastLedgerSequence passed without the transaction being included.',
      severity: 'certain',
      fix: 'This transaction is permanently dead and cannot be applied later. Safe to retry with a new sequence.',
    }],
  },
}

export async function explain(
  client: Client,
  code: string,
  context?: TxContext,
): Promise<Explanation> {
  const checked: string[] = []

  if (code === 'tesSUCCESS') {
    return { code, summary: 'Transaction succeeded.', findings: [], checked }
  }

  // the interesting one: four+ causes, no information in the code
  if (code === 'tecPATH_PARTIAL' && context?.kind === 'payment') {
    return {
      code,
      summary: 'A path exists, but not enough liquidity to deliver the full amount.',
      findings: [{
        reason: 'The sender holds less than they tried to send, or the path could only carry part of it.',
        severity: 'likely',
        fix: 'Check the sender\'s balance for this currency. Reduce the amount, or set tfPartialPayment if delivering less is acceptable.',
      }],
      checked,
    }
  }

  if (code === 'tecPATH_DRY' && context?.kind === 'payment') {
    return await explainPathDry(client, context, checked)
  }

  const stat = STATIC[code]
  if (stat) return { code, ...stat, checked }

  return {
    code,
    summary: `Transaction failed with ${code}.`,
    findings: [{
      reason: 'No specific diagnosis available for this code.',
      severity: 'unknown',
      fix: 'See https://xrpl.org/docs/references/protocol/transactions/transaction-results',
    }],
    checked,
  }
}

async function explainPathDry(
  client: Client,
  ctx: Extract<TxContext, { kind: 'payment' }>,
  checked: string[],
): Promise<Explanation> {
  const findings: Finding[] = []

  if (typeof ctx.amount === 'string') {
    checked.push('amount is XRP, not an issued token')
    return {
      code: 'tecPATH_DRY',
      summary: 'No path found to deliver this payment.',
      findings: [{
        reason: 'XRP payments do not normally fail this way unless a path was specified.',
        severity: 'possible',
        fix: 'Remove any explicit Paths field and let the engine route it.',
      }],
      checked,
    }
  }

  const { currency, issuer } = ctx.amount

  // 1. does the destination have a trust line at all?
  const lines: any = await client.request({
    command: 'account_lines',
    account: ctx.destination,
    ledger_index: 'validated',
  })
  checked.push(`read trust lines for destination ${ctx.destination}`)

  const line = (lines.result.lines ?? []).find(
    (l: any) => l.currency === currency && l.account === issuer,
  )

  if (!line) {
    findings.push({
      reason: `The destination has no trust line for ${currency} from ${issuer}.`,
      severity: 'certain',
      fix: 'The destination must submit a TrustSet transaction to opt in before they can receive this token.',
    })
    return done(findings, checked)
  }
  checked.push('trust line exists')

  // 2. does the issuer require auth, and has it authorized this line?
  const info: any = await client.request({
    command: 'account_info',
    account: issuer,
    ledger_index: 'validated',
  })
  const issuerFlags = info.result.account_data.Flags ?? 0
  checked.push(`read issuer flags: 0x${(issuerFlags >>> 0).toString(16).padStart(8, '0')}`)

  if ((issuerFlags & lsfRequireAuth) && !line.peer_authorized) {
    findings.push({
      reason: 'The issuer requires authorization and has not authorized this trust line.',
      severity: 'certain',
      fix: 'The issuer must send a TrustSet with the tfSetfAuth flag, naming the holder as the counterparty. Note this is the compliance allowlist doing its job — the holder likely has not completed KYC.',
    })
    return done(findings, checked)
  }
  checked.push('line is authorized (or issuer does not require auth)')

  // 3. frozen, either direction?
  if (line.freeze_peer) {
    findings.push({
      reason: 'The issuer has frozen this trust line.',
      severity: 'certain',
      fix: 'The issuer must clear the freeze with tfClearFreeze before this line can be used.',
    })
    return done(findings, checked)
  }
  if (line.freeze) {
    findings.push({
      reason: 'The holder has frozen their own side of this trust line.',
      severity: 'certain',
      fix: 'The holder must clear their freeze.',
    })
    return done(findings, checked)
  }
  // the sender's own line may be frozen even when the destination's is fine
  if (ctx.account !== issuer) {
    const senderLines: any = await client.request({
      command: 'account_lines',
      account: ctx.account,
      ledger_index: 'validated',
    })
    checked.push(`read sender trust line for ${ctx.account}`)

    const sl = (senderLines.result.lines ?? []).find(
      (l: any) => l.currency === currency && l.account === issuer,
    )
    if (sl?.freeze_peer) {
      findings.push({
        reason: 'The issuer has frozen the SENDER\'s trust line.',
        severity: 'certain',
        fix: 'The issuer must clear the freeze on the sender with tfClearFreeze. A frozen holder cannot send, even though their balance is intact.',
      })
      return done(findings, checked)
    }
    if (sl?.freeze) {
      findings.push({
        reason: 'The sender has frozen their own trust line.',
        severity: 'certain',
        fix: 'The sender must clear their own freeze.',
      })
      return done(findings, checked)
    }
    checked.push('sender line is not frozen')
  }

  if (issuerFlags & lsfGlobalFreeze) {
    findings.push({
      reason: 'The issuer has a global freeze on all its tokens.',
      severity: 'certain',
      fix: 'The issuer must lift the global freeze.',
    })
    return done(findings, checked)
  }
  checked.push('not frozen (line, peer, or global)')

  // 4. does the sender actually hold enough?
  if (ctx.account !== issuer) {
    const senderLines: any = await client.request({
      command: 'account_lines',
      account: ctx.account,
      ledger_index: 'validated',
    })
    checked.push(`read sender balance for ${ctx.account}`)

    const senderLine = (senderLines.result.lines ?? []).find(
      (l: any) => l.currency === currency && l.account === issuer,
    )
    const held = Number(senderLine?.balance ?? 0)
    const want = Number(ctx.amount.value)

    if (held < want) {
      findings.push({
        reason: `Sender holds ${held} ${currency} but tried to send ${want}.`,
        severity: 'certain',
        fix: 'Reduce the amount or fund the sender.',
      })
      return done(findings, checked)
    }
    checked.push(`sender holds ${held} ${currency}, enough for ${want}`)
  }

  // 5. rippling
  findings.push({
    reason: 'Everything checks out on the trust lines, so the issuer may not have DefaultRipple enabled.',
    severity: 'likely',
    fix: 'Without DefaultRipple, tokens can only move between the issuer and a holder — never holder to holder. The issuer must set asfDefaultRipple.',
  })
  return done(findings, checked)
}

function done(findings: Finding[], checked: string[]): Explanation {
  return {
    code: 'tecPATH_DRY',
    summary: findings[0]?.reason ?? 'No path found to deliver this payment.',
    findings,
    checked,
  }
}
