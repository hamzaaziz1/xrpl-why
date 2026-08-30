export type Severity = 'certain' | 'likely' | 'possible' | 'unknown'

export interface Finding {
  /** what we think actually went wrong */
  reason: string
  /** how confident we are */
  severity: Severity
  /** what the user should do about it */
  fix: string
}

export interface Explanation {
  /** the raw engine result, e.g. tecPATH_DRY */
  code: string
  /** one-line summary, safe to show a user */
  summary: string
  /** ranked causes, most likely first */
  findings: Finding[]
  /** every check we ran, in order — shown so the diagnosis is auditable */
  checked: string[]
}

export interface PaymentContext {
  kind: 'payment'
  account: string
  destination: string
  amount: { currency: string; issuer: string; value: string } | string
}

export interface OfferContext {
  kind: 'offer'
  account: string
  domainId?: string
}

export interface ClawbackContext {
  kind: 'clawback'
  issuer: string
  holder: string
  currency: string
}

export type TxContext = PaymentContext | OfferContext | ClawbackContext
